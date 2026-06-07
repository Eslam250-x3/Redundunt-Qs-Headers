import { useCallback, useState, useRef } from 'react'
import { Upload } from 'lucide-react'
import JSZip from 'jszip'
import './QuestionInput.css'

function QuestionInput({ onQuestionsLoaded }) {
    const [isDragging, setIsDragging] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [inputMode, setInputMode] = useState('file') // 'file' or 'json'
    const [jsonText, setJsonText] = useState('')
    const [fileInputKey, setFileInputKey] = useState(Date.now()) // Key for re-uploading same file
    const fileInputRef = useRef(null)

    // Helper function to extract image references from JSON content
    const extractImageReferences = useCallback((jsonData) => {
        const imageRefs = new Set()

        // Recursively search through the data structure
        const searchForImages = (obj) => {
            if (!obj) return

            if (typeof obj === 'string') {
                // Search for img tags in HTML strings
                // Create a new regex for each string to avoid global flag issues
                const regex = /<img[^>]+src=["']([^"']+)["']/gi
                let match
                while ((match = regex.exec(obj)) !== null) {
                    imageRefs.add(match[1])
                }
            } else if (Array.isArray(obj)) {
                obj.forEach(item => searchForImages(item))
            } else if (typeof obj === 'object') {
                Object.values(obj).forEach(value => searchForImages(value))
            }
        }

        // Handle both single question and array of questions
        const questions = Array.isArray(jsonData) ? jsonData : [jsonData]
        questions.forEach(question => {
            if (question.content && question.content.parts) {
                searchForImages(question.content.parts)
            }
            // Also search in root level in case structure is different
            searchForImages(question)
        })

        return Array.from(imageRefs)
    }, [])

    // Helper function to fix image references in JSON string
    const fixImageReferences = useCallback((jsonString, imageCorrections) => {
        let fixedString = jsonString
        for (const [oldName, newName] of Object.entries(imageCorrections)) {
            // Escape special regex characters
            const escapedOldName = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

            // 1. Handle standard quotes: "filename.png" or 'filename.png'
            const regex1 = new RegExp(`(["'])${escapedOldName}\\1`, 'g')
            fixedString = fixedString.replace(regex1, `$1${newName}$1`)

            // 2. Handle escaped double quotes: \"filename.png\" (common in JSON strings)
            // We match \" explicitly
            const regex2 = new RegExp(`(\\\\")?${escapedOldName}(\\\\")?`, 'g')

            // Only replace if it looks like a file path boundary to avoid partial matches on similar names
            // But since we have the full filename including extension, it's safer.
            // Let's refine logical replacement for escaped quotes specifically

            // Simpler approach for escaped quotes: match \"FILE\"
            const regexEscaped = new RegExp(`(\\\\")(${escapedOldName})\\\\"`, 'g')
            fixedString = fixedString.replace(regexEscaped, `$1${newName}\\"`)
        }
        return fixedString
    }, [])

    // Helper function to enhance image tags with required attributes and h-scroll wrapper
    const enhanceImageTags = useCallback((jsonString, imageDimensions) => {
        // Match all <img> tags (with or without self-closing) and collect replacements
        // This regex handles both regular and escaped quotes in JSON strings
        const imgTagRegex = /<img([^>]*?)\/?>/gi
        const replacements = []
        let match

        // First pass: collect all matches and their replacements
        while ((match = imgTagRegex.exec(jsonString)) !== null) {
            const fullTag = match[0]
            const attributes = match[1]

            // Check if image has src attribute
            // Handle both escaped quotes (\") and regular quotes (") for JSON compatibility
            const srcMatch = attributes.match(/src=(?:\\["']|["'])([^"'\\]+)(?:\\["']|["'])/i)
            if (!srcMatch) continue

            const imageSrc = srcMatch[1]

            // Extract existing attributes (handle escaped quotes)
            const altMatch = attributes.match(/alt=(?:\\["']|["'])([^"'\\]*)(?:\\["']|["'])/i)
            const alt = altMatch ? altMatch[1] : ''

            // Get dimensions - prioritize JSON attributes over calculated dimensions
            let width, height
            const existingWidth = attributes.match(/width=(?:\\["']|["'])([^"'\\]+)(?:\\["']|["'])/i)
            const existingHeight = attributes.match(/height=(?:\\["']|["'])([^"'\\]+)(?:\\["']|["'])/i)

            // Use JSON dimensions first, fall back to calculated dimensions
            if (existingWidth && existingHeight) {
                width = existingWidth[1]
                height = existingHeight[1]
                console.log(`[QuestionInput] Using JSON dimensions for ${imageSrc}: ${width}x${height}`)
            } else if (imageDimensions[imageSrc]) {
                width = imageDimensions[imageSrc].width
                height = imageDimensions[imageSrc].height
                console.log(`[QuestionInput] Using calculated dimensions for ${imageSrc}: ${width}x${height}`)
            } else {
                // No dimensions available - skip this image
                // User requirement: do not use default values
                console.warn(`Skipping image ${imageSrc} - no dimensions available`)
                continue
            }

            // Detect if we're in a JSON context (escaped quotes) or raw HTML
            const isJsonContext = fullTag.includes('\\"') || fullTag.includes("\\'")
            const quote = isJsonContext ? '\\"' : '"'

            // Build the new img tag with proper attribute order:
            // alt, class, src, style, height, width
            const aspectRatio = `aspect-ratio: ${width}/${height};`
            const newImgTag = `<img alt=${quote}${alt}${quote} class=${quote}displayed-image${quote} src=${quote}${imageSrc}${quote} style=${quote}${aspectRatio}${quote} height=${quote}${height}${quote} width=${quote}${width}${quote}/>`

            // Only update the img tag, don't add wrapper divs
            replacements.push({ old: fullTag, new: newImgTag })
        }

        // Second pass: apply replacements
        // Use a map to avoid duplicate replacements
        const replacementMap = new Map()
        replacements.forEach(({ old, new: newTag }) => {
            // Escape special regex characters in old tag
            const escapedOld = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            replacementMap.set(escapedOld, newTag)
        })

        let enhancedString = jsonString
        // Apply all replacements using global regex
        replacementMap.forEach((newTag, escapedOld) => {
            const regex = new RegExp(escapedOld, 'g')
            enhancedString = enhancedString.replace(regex, newTag)
        })

        return enhancedString
    }, [])

    // Helper function to get image dimensions from blob URLs
    const getImageDimensions = useCallback(async (imageBlobs) => {
        const dimensions = {}

        for (const [imageName, blobUrl] of Object.entries(imageBlobs)) {
            try {
                const isSvg = imageName.toLowerCase().endsWith('.svg')

                if (isSvg) {
                    // For SVG files, try to read dimensions from the SVG content
                    try {
                        const response = await fetch(blobUrl)
                        const svgText = await response.text()

                        // Parse SVG using DOMParser to properly query the root svg element
                        const parser = new DOMParser()
                        const svgDoc = parser.parseFromString(svgText, 'image/svg+xml')
                        const svgElement = svgDoc.querySelector('svg')

                        let width, height

                        if (svgElement) {
                            // Try to get dimensions from width/height attributes on the root svg element
                            const widthAttr = svgElement.getAttribute('width')
                            const heightAttr = svgElement.getAttribute('height')

                            if (widthAttr && heightAttr) {
                                // Parse width/height (remove units like px, pt, etc)
                                width = parseFloat(widthAttr)
                                height = parseFloat(heightAttr)
                            } else {
                                // Fallback: Try to get dimensions from viewBox attribute
                                const viewBox = svgElement.getAttribute('viewBox')
                                if (viewBox) {
                                    // Parse viewBox: "minX minY width height"
                                    const viewBoxParts = viewBox.split(/[\s,]+/)
                                    if (viewBoxParts.length >= 4) {
                                        width = parseFloat(viewBoxParts[2])
                                        height = parseFloat(viewBoxParts[3])
                                    }
                                }
                            }
                        }

                        if (width && height && !isNaN(width) && !isNaN(height)) {
                            dimensions[imageName] = { width, height }
                            console.log(`[SVG] Got dimensions for ${imageName}: ${width}x${height}`)
                            continue
                        }
                    } catch (svgError) {
                        console.warn(`Failed to parse SVG dimensions for ${imageName}:`, svgError)
                    }
                }

                // Fallback: try loading as image
                const img = new Image()
                await new Promise((resolve, reject) => {
                    img.onload = () => {
                        dimensions[imageName] = {
                            width: img.naturalWidth || 220,
                            height: img.naturalHeight || 220
                        }
                        resolve()
                    }
                    img.onerror = () => {
                        // Use default dimensions if failed
                        console.warn(`Failed to load image ${imageName}, using defaults`)
                        dimensions[imageName] = { width: 220, height: 220 }
                        resolve() // Don't reject, just use defaults
                    }
                    img.src = blobUrl
                })
            } catch (error) {
                console.warn(`Failed to get dimensions for ${imageName}:`, error)
                // Use default dimensions if failed
                dimensions[imageName] = { width: 220, height: 220 }
            }
        }

        return dimensions
    }, [])

    const processJsonContent = useCallback((content, filename = 'manual') => {
        try {
            const data = JSON.parse(content)
            // Handle single question or array of questions
            const questions = Array.isArray(data) ? data : [data]

            // Ensure each question has an ID
            const processedQuestions = questions.map((q, index) => {
                const id = q.id || q.questionId || q.question_id || `q-${index + 1}`
                return {
                    id,
                    data: q,
                    filename
                }
            })

            return processedQuestions
        } catch (error) {
            console.error('Failed to parse JSON:', error)
            throw new Error('Invalid JSON file')
        }
    }, [])

    const processZipFile = useCallback(async (file) => {
        const zip = await JSZip.loadAsync(file)
        const questions = []

        // Get all files and organize by folder
        const folderMap = new Map()
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp']

        // Helper function to check if a string is 12 digits
        const is12Digits = (str) => /^\d{12}$/.test(str)

        // Helper function to extract question ID from filename
        const extractQuestionId = (fileName) => {
            // Match pattern: 12 digits at the start of filename
            const match = fileName.match(/^(\d{12})/)
            return match ? match[1] : null
        }

        // Process all files in the zip
        for (const [filePath, zipEntry] of Object.entries(zip.files)) {
            // Skip directories and macOS metadata
            if (zipEntry.dir || filePath.includes('__MACOSX')) continue

            const pathParts = filePath.split('/')
            let folderName, fileName

            // Handle both structures:
            // 1. Files in folders: "123456789012/123456789012.json"
            // 2. Files in root: "123456789012.json"
            if (pathParts.length >= 2) {
                // Files in folders
                folderName = pathParts[0]
                fileName = pathParts[pathParts.length - 1]

                // Only process folders with 12-digit names
                if (!is12Digits(folderName)) {
                    console.warn(`Skipping folder with invalid name (not 12 digits): ${folderName}`)
                    continue
                }
            } else {
                // Files in root - extract question ID from filename
                fileName = pathParts[0]
                folderName = extractQuestionId(fileName)

                if (!folderName) {
                    console.warn(`Skipping root file with invalid name (cannot extract 12-digit ID): ${fileName}`)
                    continue
                }
            }

            if (!folderMap.has(folderName)) {
                folderMap.set(folderName, {
                    id: folderName,
                    jsonFile: null,
                    images: []
                })
            }

            const folderData = folderMap.get(folderName)

            // Check if it's the JSON file (should be: folderName.json)
            if (fileName === `${folderName}.json`) {
                folderData.jsonFile = { path: filePath, entry: zipEntry }
            }
            // Check if it's an image file (should start with: folderName.XX)
            // Format: 123456789012.01.png, 123456789012.02.jpg, etc.
            else if (fileName.startsWith(`${folderName}.`) &&
                imageExtensions.some(ext => fileName.toLowerCase().endsWith(ext))) {
                folderData.images.push({ path: filePath, entry: zipEntry, name: fileName })
            }
        }

        // Process each folder
        for (const [questionId, folderData] of folderMap.entries()) {
            try {
                if (!folderData.jsonFile) {
                    console.warn(`No JSON file found in folder: ${questionId} (expected: ${questionId}.json)`)
                    continue
                }

                // Read JSON file
                let jsonContent = await folderData.jsonFile.entry.async('string')
                let jsonData = JSON.parse(jsonContent)

                // Build a map of actual image files: { baseName: actualFileName }
                // Base name is the filename without extension (e.g., "909134141892.01" from "909134141892.01.jpg")
                const actualImagesMap = new Map()
                folderData.images.forEach(image => {
                    // Extract base name (remove extension)
                    const baseName = image.name.replace(/\.[^.]+$/, '')
                    actualImagesMap.set(baseName, image.name)
                })

                // Log available images for debugging
                console.log(`[${questionId}] 📁 Available images in ZIP:`,
                    folderData.images.map(img => img.name).join(', ') || 'None'
                )

                // Extract image references from JSON
                const imageRefs = extractImageReferences(jsonData)
                const imageCorrections = {}
                const missingImages = []

                console.log(`[${questionId}] 📄 Images referenced in JSON:`, imageRefs.join(', ') || 'None')

                // Match JSON image references with actual files
                for (const imageRef of imageRefs) {
                    // Extract base name from reference (remove extension)
                    const baseName = imageRef.replace(/\.[^.]+$/, '')

                    // Check if actual file exists with this base name
                    if (actualImagesMap.has(baseName)) {
                        const actualFileName = actualImagesMap.get(baseName)

                        // If extension differs, add to corrections
                        if (imageRef !== actualFileName) {
                            imageCorrections[imageRef] = actualFileName
                            console.log(`[${questionId}] ✅ Fixing image extension: ${imageRef} → ${actualFileName}`)
                        }
                    } else {
                        // Image referenced in JSON but not found in folder
                        missingImages.push(imageRef)
                        console.warn(`[${questionId}] ⚠️ Image NOT found in folder: ${imageRef}`)
                        console.warn(`[${questionId}] 💡 Available base names:`, Array.from(actualImagesMap.keys()).join(', '))
                    }
                }

                // Fix JSON content if corrections are needed
                if (Object.keys(imageCorrections).length > 0) {
                    jsonContent = fixImageReferences(jsonContent, imageCorrections)
                    jsonData = JSON.parse(jsonContent)
                    console.log(`[${questionId}] Fixed ${Object.keys(imageCorrections).length} image reference(s)`)
                }

                // Process images - create blob URLs
                // Sort images by name to maintain order (.01, .02, etc.)
                const sortedImages = folderData.images.sort((a, b) =>
                    a.name.localeCompare(b.name)
                )

                const imageBlobs = {}
                for (const image of sortedImages) {
                    try {
                        const imageData = await image.entry.async('arraybuffer')

                        // Determine MIME type based on extension
                        const ext = image.name.split('.').pop().toLowerCase()
                        const mimeTypes = {
                            'svg': 'image/svg+xml',
                            'png': 'image/png',
                            'jpg': 'image/jpeg',
                            'jpeg': 'image/jpeg',
                            'gif': 'image/gif',
                            'webp': 'image/webp',
                            'bmp': 'image/bmp'
                        }
                        const mimeType = mimeTypes[ext] || 'image/png'

                        // Create blob with correct MIME type
                        const imageBlob = new Blob([imageData], { type: mimeType })
                        const imageUrl = URL.createObjectURL(imageBlob)
                        imageBlobs[image.name] = imageUrl

                        console.log(`[${questionId}] Loaded image: ${image.name} (${mimeType})`)
                    } catch (error) {
                        console.warn(`[${questionId}] Failed to load image ${image.name}:`, error)
                    }
                }

                // Get image dimensions for enhancement
                const imageDimensions = await getImageDimensions(imageBlobs)

                // Create a map from image references (as they appear in JSON after corrections) to dimensions
                const imageRefToDimensions = {}
                for (const imageRef of imageRefs) {
                    // Get the corrected image name (or original if no correction)
                    // This is the name as it will appear in JSON after fixImageReferences
                    const correctedName = imageCorrections[imageRef] || imageRef

                    // Find the actual file name (might have different extension)
                    const baseName = correctedName.replace(/\.[^.]+$/, '')
                    if (actualImagesMap.has(baseName)) {
                        const actualFileName = actualImagesMap.get(baseName)
                        if (imageDimensions[actualFileName]) {
                            // Map the reference (as it appears in JSON after corrections) to dimensions
                            imageRefToDimensions[correctedName] = imageDimensions[actualFileName]
                        }
                    }
                }

                // Enhance image tags with required attributes
                if (Object.keys(imageRefToDimensions).length > 0) {
                    jsonContent = enhanceImageTags(jsonContent, imageRefToDimensions)
                    jsonData = JSON.parse(jsonContent)
                    console.log(`[${questionId}] Enhanced image tags with required attributes`)
                }

                // Update questionData with enhanced JSON
                const enhancedQuestionData = {
                    ...jsonData,
                    id: questionId
                }

                questions.push({
                    id: questionId,
                    data: enhancedQuestionData,
                    filename: folderData.jsonFile.path,
                    images: imageBlobs // Store image URLs
                })
            } catch (error) {
                console.warn(`Failed to process folder ${questionId}:`, error)
            }
        }

        return questions
    }, [extractImageReferences, fixImageReferences, enhanceImageTags, getImageDimensions])

    const handleFiles = useCallback(async (files) => {
        setIsLoading(true)
        const allQuestions = []

        try {
            for (const file of files) {
                if (file.name.endsWith('.zip')) {
                    const questions = await processZipFile(file)
                    allQuestions.push(...questions)
                } else if (file.name.endsWith('.json')) {
                    const content = await file.text()
                    const questions = processJsonContent(content, file.name)
                    allQuestions.push(...questions)
                }
            }

            if (allQuestions.length > 0) {
                onQuestionsLoaded(allQuestions)
            }
        } catch (error) {
            console.error('Error processing files:', error)
            alert(error.message || 'An error occurred while processing files')
        } finally {
            setIsLoading(false)
        }
    }, [onQuestionsLoaded, processJsonContent, processZipFile])

    const handleDrop = useCallback((e) => {
        e.preventDefault()
        setIsDragging(false)
        const files = Array.from(e.dataTransfer.files)
        handleFiles(files)
    }, [handleFiles])

    const handleDragOver = useCallback((e) => {
        e.preventDefault()
        setIsDragging(true)
    }, [])

    const handleDragLeave = useCallback((e) => {
        e.preventDefault()
        setIsDragging(false)
    }, [])

    const handleFileSelect = useCallback((e) => {
        const files = Array.from(e.target.files)
        handleFiles(files)
    }, [handleFiles])

    const handleJsonSubmit = useCallback(() => {
        if (!jsonText.trim()) return

        setIsLoading(true)
        try {
            const questions = processJsonContent(jsonText)
            onQuestionsLoaded(questions)
            setJsonText('')
        } catch (error) {
            alert(error.message)
        } finally {
            setIsLoading(false)
        }
    }, [jsonText, onQuestionsLoaded, processJsonContent])

    return (
        <div className="question-input glass-card">
            <div className="input-header">
                <h3>📥 Load Questions</h3>
                <div className="input-mode-toggle">
                    <button
                        className={`mode-btn ${inputMode === 'file' ? 'active' : ''}`}
                        onClick={() => setInputMode('file')}
                    >
                        File
                    </button>
                    <button
                        className={`mode-btn ${inputMode === 'json' ? 'active' : ''}`}
                        onClick={() => setInputMode('json')}
                    >
                        JSON
                    </button>
                </div>
            </div>

            {inputMode === 'file' ? (
                <div
                    className={`drop-zone ${isDragging ? 'active' : ''} ${isLoading ? 'loading' : ''}`}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onClick={() => fileInputRef.current?.click()}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            fileInputRef.current?.click()
                        }
                    }}
                    aria-label="Drop zone for file upload, click or press Enter to select files"
                >
                    {isLoading ? (
                        <div className="loading-indicator">
                            <div className="spinner"></div>
                            <span>Loading...</span>
                        </div>
                    ) : (
                        <>
                            <Upload className="drop-icon" size={48} strokeWidth={1.5} />
                            <p className="drop-text">Drag files here</p>
                            <p className="drop-hint">or click to select</p>
                            <p className="drop-formats">JSON or ZIP</p>
                        </>
                    )}
                    <input
                        key={fileInputKey}
                        ref={fileInputRef}
                        type="file"
                        accept=".json,.zip"
                        multiple
                        onChange={(e) => {
                            handleFileSelect(e)
                            // Reset key to allow re-uploading same file
                            setFileInputKey(Date.now())
                        }}
                        style={{ display: 'none' }}
                        aria-hidden="true"
                    />
                </div>
            ) : (
                <div className="json-input-area">
                    <textarea
                        value={jsonText}
                        onChange={(e) => setJsonText(e.target.value)}
                        placeholder='Paste JSON content here...'
                        rows={6}
                        aria-label="JSON input text area"
                    />
                    <button
                        className="btn btn-primary w-full"
                        onClick={handleJsonSubmit}
                        disabled={!jsonText.trim() || isLoading}
                        aria-label="Load question from JSON"
                    >
                        {isLoading ? 'Processing...' : 'Load Question'}
                    </button>
                </div>
            )}
        </div>
    )
}

export default QuestionInput
