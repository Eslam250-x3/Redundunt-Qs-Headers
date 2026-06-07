import { useState, useMemo, useEffect, useRef } from 'react'
import { Settings, Lock, Unlock, RotateCcw, Check } from 'lucide-react'
import './ImageSettings.css'

// Sanitize string to prevent XSS
const sanitizeString = (str) => {
    if (!str) return ''
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
}

// Helper function to extract images from question data
const extractImagesFromQuestion = (question) => {
    if (!question?.data) return []

    // Use Map to track unique images by src (deduplicate)
    const imagesMap = new Map()

    const searchForImages = (obj, path = '') => {
        if (!obj) return

        if (typeof obj === 'string') {
            // Match img tags (with or without self-closing)
            const regex = /<img([^>]*?)\/?>/gi
            let match
            while ((match = regex.exec(obj)) !== null) {
                const attrs = match[1]
                const srcMatch = attrs.match(/src=["']([^"']+)["']/i)
                const widthMatch = attrs.match(/width=["']([^"']+)["']/i)
                const heightMatch = attrs.match(/height=["']([^"']+)["']/i)
                const altMatch = attrs.match(/alt=["']([^"']*)["']/i)
                const variationMatch = attrs.match(/data-node-variation=["']([^"']+)["']/i)

                if (srcMatch) {
                    const imageSrc = srcMatch[1]

                    // Only add if this src hasn't been seen before (deduplicate)
                    if (!imagesMap.has(imageSrc)) {
                        // Check for wrappers
                        const beforeTag = obj.substring(Math.max(0, match.index - 200), match.index)
                        const afterTagEnd = match.index + match[0].length
                        const afterTag = obj.substring(afterTagEnd, Math.min(obj.length, afterTagEnd + 50))

                        // Check for Old Div Wrapper
                        const divWrapperStartRegex = /<div\s+class=["']h-scroll["']>\s*$/
                        const divWrapperEndRegex = /^\s*<\/div>/
                        const isWrappedOld = divWrapperStartRegex.test(beforeTag) && divWrapperEndRegex.test(afterTag)

                        // Check for New Span Wrapper
                        const spanWrapperStartRegex = /<span\s+class=["'][^"']*LexicalTheme__image[^"']*["'][^>]*>\s*$/
                        const spanWrapperEndRegex = /^\s*<\/span>/
                        const isWrappedNew = spanWrapperStartRegex.test(beforeTag) && spanWrapperEndRegex.test(afterTag)

                        // Check for <span>&nbsp; wrapper (bad pattern that needs cleanup)
                        const nbspSpanWrapperStartRegex = /<span>&nbsp;\s*$/
                        const nbspSpanWrapperEndRegex = /^\s*<\/span>/
                        const isWrappedNbsp = nbspSpanWrapperStartRegex.test(beforeTag) && nbspSpanWrapperEndRegex.test(afterTag)

                        const isWrapped = isWrappedOld || isWrappedNew || isWrappedNbsp

                        // Calculate the full match including wrapper if present
                        let fullMatch = match[0]
                        let matchStart = match.index

                        if (isWrappedOld) {
                            const wrapperStartMatch = beforeTag.match(divWrapperStartRegex)
                            const wrapperEndMatch = afterTag.match(divWrapperEndRegex)
                            if (wrapperStartMatch && wrapperEndMatch) {
                                matchStart = match.index - wrapperStartMatch[0].length
                                fullMatch = obj.substring(matchStart, afterTagEnd + wrapperEndMatch[0].length)
                            }
                        } else if (isWrappedNew) {
                            const wrapperStartMatch = beforeTag.match(spanWrapperStartRegex)
                            const wrapperEndMatch = afterTag.match(spanWrapperEndRegex)
                            if (wrapperStartMatch && wrapperEndMatch) {
                                matchStart = match.index - wrapperStartMatch[0].length
                                fullMatch = obj.substring(matchStart, afterTagEnd + wrapperEndMatch[0].length)
                            }
                        } else if (isWrappedNbsp) {
                            const wrapperStartMatch = beforeTag.match(nbspSpanWrapperStartRegex)
                            const wrapperEndMatch = afterTag.match(nbspSpanWrapperEndRegex)
                            if (wrapperStartMatch && wrapperEndMatch) {
                                matchStart = match.index - wrapperStartMatch[0].length
                                fullMatch = obj.substring(matchStart, afterTagEnd + wrapperEndMatch[0].length)
                            }
                        }

                        // Determine variation from wrapper if present and not on img
                        let variation = variationMatch ? variationMatch[1] : 'block'
                        if (isWrappedNew) {
                            // Check for data-node-variation on wrapper
                            const wrapperStart = beforeTag.match(spanWrapperStartRegex)[0]
                            const wrapperVarMatch = wrapperStart.match(/data-node-variation=["']([^"']+)["']/i)
                            if (wrapperVarMatch) {
                                variation = wrapperVarMatch[1]
                            }
                        }

                        imagesMap.set(imageSrc, {
                            src: imageSrc,
                            // Use actual dimensions from img tag, or null if not specified
                            // No default values per user requirement
                            width: widthMatch ? parseFloat(widthMatch[1]) : null,
                            height: heightMatch ? parseFloat(heightMatch[1]) : null,
                            alt: altMatch ? altMatch[1] : '',
                            variation: variation,
                            fullTag: fullMatch,
                            imgTagOnly: match[0],
                            isWrapped,
                            path
                        })
                    }
                }
            }
        } else if (Array.isArray(obj)) {
            obj.forEach((item, idx) => searchForImages(item, `${path}[${idx}]`))
        } else if (typeof obj === 'object') {
            Object.entries(obj).forEach(([key, value]) =>
                searchForImages(value, path ? `${path}.${key}` : key)
            )
        }
    }

    searchForImages(question.data)
    // Return array of unique images only
    return Array.from(imagesMap.values())
}

function ImageSettings({ question, onUpdateQuestion }) {
    const extractedImages = useMemo(() => extractImagesFromQuestion(question), [question])

    const [localSettings, setLocalSettings] = useState({})
    const [selectedImageIndex, setSelectedImageIndex] = useState(0)
    const [aspectRatios, setAspectRatios] = useState({})
    const [lockAspectRatio, setLockAspectRatio] = useState(true) // Locked by default

    // Track the last question ID to detect when question changes vs data updates
    const lastQuestionIdRef = useRef(null)

    // Sync localSettings and aspectRatios only when question ID changes (new question selected)
    // NOT when data changes (after Apply Changes)
    useEffect(() => {
        const currentId = question?.id

        // Only reset settings when a different question is selected
        if (currentId !== lastQuestionIdRef.current) {
            lastQuestionIdRef.current = currentId

            const settings = {}
            const ratios = {}
            extractedImages.forEach((img, idx) => {
                settings[idx] = {
                    width: img.width,
                    height: img.height,
                    alt: img.alt,
                    variation: img.variation
                }
                // Calculate aspect ratio from original dimensions
                ratios[idx] = img.width / img.height
            })
            setLocalSettings(settings)
            setAspectRatios(ratios)
        }
    }, [question?.id, extractedImages])

    // Reset selectedImageIndex when images change (fixes bounds issue)
    useEffect(() => {
        if (selectedImageIndex >= extractedImages.length) {
            setSelectedImageIndex(Math.max(0, extractedImages.length - 1))
        }
    }, [extractedImages.length, selectedImageIndex])

    const currentImage = extractedImages[selectedImageIndex]
    const currentSettings = localSettings[selectedImageIndex] || {}
    const currentAspectRatio = aspectRatios[selectedImageIndex]

    // Get image blob URL - try exact match first, then fallback to finding by base name
    const getImageBlobUrl = (imageSrc) => {
        if (!question.images) {
            console.log(`[getImageBlobUrl] No images object, returning original: ${imageSrc}`)
            return imageSrc
        }

        // Try exact match
        if (question.images[imageSrc]) {
            return question.images[imageSrc]
        }

        // Fallback: try matching by base name (without extension)
        const baseName = imageSrc.replace(/\.[^.]+$/, '')
        for (const [key, value] of Object.entries(question.images)) {
            const keyBaseName = key.replace(/\.[^.]+$/, '')
            if (keyBaseName === baseName) {
                console.log(`[getImageBlobUrl] Found by baseName: ${imageSrc} → ${key}`)
                return value
            }
        }

        // Fallback: try case-insensitive match
        const lowerSrc = imageSrc.toLowerCase()
        for (const [key, value] of Object.entries(question.images)) {
            if (key.toLowerCase() === lowerSrc) {
                console.log(`[getImageBlobUrl] Found by case-insensitive: ${imageSrc} → ${key}`)
                return value
            }
        }

        console.warn(`[getImageBlobUrl] Image not found: ${imageSrc}`)
        console.warn(`[getImageBlobUrl] Available images:`, Object.keys(question.images))
        return imageSrc
    }

    const handleSettingChange = (key, value) => {
        setLocalSettings(prev => {
            const currentRatio = aspectRatios[selectedImageIndex]
            const newSettings = { ...prev[selectedImageIndex] }

            if (lockAspectRatio && currentRatio && (key === 'width' || key === 'height')) {
                if (key === 'width') {
                    const newWidth = parseFloat(value)
                    if (!isNaN(newWidth) && newWidth > 0) {
                        const newHeight = Math.round(newWidth / currentRatio)
                        newSettings.width = newWidth
                        newSettings.height = newHeight
                    }
                } else if (key === 'height') {
                    const newHeight = parseFloat(value)
                    if (!isNaN(newHeight) && newHeight > 0) {
                        const newWidth = Math.round(newHeight * currentRatio)
                        newSettings.height = newHeight
                        newSettings.width = newWidth
                    }
                }
            } else {
                newSettings[key] = value
            }

            return {
                ...prev,
                [selectedImageIndex]: newSettings
            }
        })
    }

    const applyChanges = () => {
        if (!question || !onUpdateQuestion) return

        // Work directly on the data object instead of JSON string manipulation
        // This avoids quote escaping issues
        // Loop to replace ALL occurrences of the same image
        const updateImageInString = (str, oldSrc, newImgTag, variation) => {
            if (typeof str !== 'string') return str

            // Escape regex chars
            const escapedSrc = oldSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

            // Use global flag to find ALL occurrences
            const imgRegex = new RegExp(`(<img[^>]*src=["']${escapedSrc}["'][^>]*(?:/>|>))`, 'gi')

            let result = str
            let match
            let offset = 0

            // Create a temporary copy for matching
            const matchRegex = new RegExp(`(<img[^>]*src=["']${escapedSrc}["'][^>]*(?:/>|>))`, 'gi')
            const matches = []
            while ((match = matchRegex.exec(str)) !== null) {
                matches.push({ index: match.index, length: match[0].length, tag: match[0] })
            }

            // Process matches in reverse order to maintain correct indices
            for (let i = matches.length - 1; i >= 0; i--) {
                const m = matches[i]
                const imgTag = m.tag
                const index = m.index

                // Check for existing wrappers
                const beforeContext = result.substring(Math.max(0, index - 200), index)
                const afterContext = result.substring(index + imgTag.length, Math.min(result.length, index + imgTag.length + 50))

                // Wrapper Regexes
                const divWrapperStartRegex = /<div\s+class=["']h-scroll["']>\s*$/
                const divWrapperEndRegex = /^\s*<\/div>/

                const spanWrapperStartRegex = /<span\s+class=["'][^"']*LexicalTheme__image[^"']*["'][^>]*>\s*$/
                const spanWrapperEndRegex = /^\s*<\/span>/

                // Check for <span>&nbsp; wrapper (bad pattern)
                const nbspSpanWrapperStartRegex = /<span>&nbsp;\s*$/
                const nbspSpanWrapperEndRegex = /^\s*<\/span>/

                let startIndex = index
                let endIndex = index + imgTag.length

                // Check for Div Wrapper
                const divStartMatch = beforeContext.match(divWrapperStartRegex)
                const divEndMatch = afterContext.match(divWrapperEndRegex)

                if (divStartMatch && divEndMatch) {
                    startIndex = index - divStartMatch[0].length
                    endIndex = index + imgTag.length + divEndMatch[0].length
                }
                // Check for Span Wrapper
                else {
                    const spanStartMatch = beforeContext.match(spanWrapperStartRegex)
                    const spanEndMatch = afterContext.match(spanWrapperEndRegex)
                    if (spanStartMatch && spanEndMatch) {
                        startIndex = index - spanStartMatch[0].length
                        endIndex = index + imgTag.length + spanEndMatch[0].length
                    }
                    // Check for <span>&nbsp; wrapper (bad pattern to remove)
                    else {
                        const nbspStartMatch = beforeContext.match(nbspSpanWrapperStartRegex)
                        const nbspEndMatch = afterContext.match(nbspSpanWrapperEndRegex)
                        if (nbspStartMatch && nbspEndMatch) {
                            startIndex = index - nbspStartMatch[0].length
                            endIndex = index + imgTag.length + nbspEndMatch[0].length
                        }
                    }
                }

                if (variation === 'block') {
                    const wrapper = `<span class="LexicalTheme__image LexicalTheme__image--block h-scroll" data-node-type="image" data-node-variation="block">${newImgTag}</span>`
                    result = result.substring(0, startIndex) + wrapper + result.substring(endIndex)
                } else {
                    // Inline — keep the Lexical inline wrapper so the image stays in the text line
                    // (a bare <img> loses LexicalTheme__image--inline and often renders on its own line)
                    const wrapper = `<span class="LexicalTheme__image LexicalTheme__image--inline h-scroll" data-node-type="image" data-node-variation="inline" style="vertical-align: middle;">${newImgTag}</span>`
                    result = result.substring(0, startIndex) + wrapper + result.substring(endIndex)
                }
            }

            return result
        }

        const updateImagesRecursively = (obj, oldSrc, newImgTag, variation) => {
            if (obj === null || obj === undefined) return obj

            if (typeof obj === 'string') {
                return updateImageInString(obj, oldSrc, newImgTag, variation)
            }

            if (Array.isArray(obj)) {
                return obj.map(item => updateImagesRecursively(item, oldSrc, newImgTag, variation))
            }

            if (typeof obj === 'object') {
                const newObj = {}
                for (const [key, value] of Object.entries(obj)) {
                    newObj[key] = updateImagesRecursively(value, oldSrc, newImgTag, variation)
                }
                return newObj
            }

            return obj
        }

        // Deep clone the question data
        let updatedData = JSON.parse(JSON.stringify(question.data))

        // Cleanup function to remove <br> before images and consecutive <br><br>
        const cleanupBrTags = (obj) => {
            if (obj === null || obj === undefined) return obj

            if (typeof obj === 'string') {
                let cleaned = obj
                // Remove <br> immediately before <img or <span with image
                cleaned = cleaned.replace(/<br\s*\/?>\s*(<img|<span\s+class="[^"]*LexicalTheme__image)/gi, '$1')
                // Remove <br> immediately after image wrapper closing </span>
                cleaned = cleaned.replace(/(<\/span>)\s*<br\s*\/?>/gi, '$1')
                // Remove <br> immediately after self-closing img tag
                cleaned = cleaned.replace(/(<img[^>]*\/>)\s*<br\s*\/?>/gi, '$1')
                // Remove consecutive <br><br> (with optional whitespace between)
                cleaned = cleaned.replace(/(<br\s*\/?>)\s*(<br\s*\/?>)/gi, '')
                return cleaned
            }

            if (Array.isArray(obj)) {
                return obj.map(item => cleanupBrTags(item))
            }

            if (typeof obj === 'object') {
                const newObj = {}
                for (const [key, value] of Object.entries(obj)) {
                    newObj[key] = cleanupBrTags(value)
                }
                return newObj
            }

            return obj
        }

        // Apply all image settings
        extractedImages.forEach((img, idx) => {
            const settings = localSettings[idx]
            if (!settings) return

            // Skip images without valid dimensions
            const width = parseFloat(settings.width)
            const height = parseFloat(settings.height)
            if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
                console.warn(`Skipping image ${img.src} - invalid dimensions`)
                return
            }

            // Apply constraints without default fallback
            const safeWidth = Math.min(2000, Math.max(50, width))
            const safeHeight = Math.min(2000, Math.max(50, height))
            const sanitizedAlt = settings.alt ? sanitizeString(settings.alt) : ''
            const safeVariation = ['block', 'inline'].includes(settings.variation) ? settings.variation : 'block'

            // Calculate aspect ratio style
            const aspectRatioStyle = `aspect-ratio: ${safeWidth}/${safeHeight};`

            // Construct new img tag only (no wrapper divs)
            const newImgTag = `<img alt="${sanitizedAlt}" class="displayed-image" src="${img.src}" style="${aspectRatioStyle}" height="${safeHeight}" width="${safeWidth}"/>`

            // Update the data recursively (now updates ALL occurrences)
            updatedData = updateImagesRecursively(updatedData, img.src, newImgTag, safeVariation)
        })

        // Cleanup <br> tags before images and consecutive <br><br>
        updatedData = cleanupBrTags(updatedData)

        onUpdateQuestion({
            ...question,
            data: updatedData
        })
    }

    if (extractedImages.length === 0) {
        return (
            <div className="image-settings glass-card">
                <div className="settings-header">
                    <Settings className="settings-icon" size={20} strokeWidth={2} />
                    <h4>Image Settings</h4>
                </div>
                <div className="no-images">
                    <p>No images found in this question</p>
                </div>
            </div>
        )
    }

    return (
        <div className="image-settings glass-card">
            <div className="settings-header">
                <Settings className="settings-icon" size={24} strokeWidth={2} />
                <h4>Image Settings</h4>
                <span className="image-count">{extractedImages.length}</span>
            </div>

            {/* Image Selector */}
            {extractedImages.length > 1 && (
                <div className="image-selector">
                    {extractedImages.map((img, idx) => (
                        <button
                            key={idx}
                            className={`image-tab ${selectedImageIndex === idx ? 'active' : ''}`}
                            onClick={() => setSelectedImageIndex(idx)}
                        >
                            <span className="tab-index">{idx + 1}</span>
                            <span className="tab-name">{img.src.split('/').pop()}</span>
                        </button>
                    ))}
                </div>
            )}

            {/* Image Preview */}
            {currentImage && (
                <div className="image-preview-small">
                    <img
                        src={getImageBlobUrl(currentImage.src)}
                        alt={currentSettings.alt || 'Preview'}
                        style={{
                            width: `${Math.min(currentSettings.width || 100, 150)}px`,
                            height: 'auto',
                            objectFit: 'contain',
                            maxHeight: '150px',
                            backgroundColor: '#f5f5f5'
                        }}
                        onError={(e) => {
                            console.warn(`Failed to load preview for ${currentImage.src}`)
                            // Show placeholder on error
                            e.target.alt = '🖼️ Preview not available'
                            e.target.style.fontSize = '24px'
                            e.target.style.display = 'flex'
                            e.target.style.alignItems = 'center'
                            e.target.style.justifyContent = 'center'
                        }}
                    />
                </div>
            )}

            {/* Settings Form */}
            <div className="settings-form">
                <div className="dimension-controls">
                    <div className="setting-row">
                        <label>Width (px)</label>
                        <input
                            type="number"
                            value={currentSettings.width != null ? Math.round(currentSettings.width) : ''}
                            onChange={(e) => handleSettingChange('width', e.target.value)}
                            min="50"
                            max="2000"
                            step="1"
                            placeholder="Width"
                            aria-label="Image width in pixels"
                        />
                    </div>

                    <button
                        className={`aspect-ratio-lock ${lockAspectRatio ? 'locked' : 'unlocked'}`}
                        onClick={() => setLockAspectRatio(!lockAspectRatio)}
                        title={lockAspectRatio ? 'Aspect ratio locked - click to unlock' : 'Aspect ratio unlocked - click to lock'}
                        aria-label={lockAspectRatio ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                        aria-pressed={lockAspectRatio}
                    >
                        {lockAspectRatio ? <Lock size={20} strokeWidth={2} /> : <Unlock size={20} strokeWidth={2} />}
                    </button>

                    <div className="setting-row">
                        <label>Height (px)</label>
                        <input
                            type="number"
                            value={currentSettings.height != null ? Math.round(currentSettings.height) : ''}
                            onChange={(e) => handleSettingChange('height', e.target.value)}
                            min="50"
                            max="2000"
                            step="1"
                            placeholder="Height"
                            aria-label="Image height in pixels"
                        />
                    </div>
                </div>

                {currentAspectRatio && (
                    <div className="aspect-ratio-info">
                        <span>Aspect Ratio: {currentAspectRatio.toFixed(2)}</span>
                    </div>
                )}

                <div className="setting-row">
                    <label>Alt Text</label>
                    <input
                        type="text"
                        value={currentSettings.alt || ''}
                        onChange={(e) => handleSettingChange('alt', e.target.value)}
                        placeholder="Image description"
                    />
                </div>

                <div className="setting-row">
                    <label>Display Mode</label>
                    <select
                        value={currentSettings.variation || 'block'}
                        onChange={(e) => handleSettingChange('variation', e.target.value)}
                    >
                        <option value="block">Block</option>
                        <option value="inline">Inline</option>
                    </select>
                </div>
            </div>

            {/* Action Buttons */}
            <div className="settings-actions">
                <button
                    className="btn btn-secondary"
                    onClick={() => {
                        // Reset to original values
                        if (currentImage) {
                            handleSettingChange('width', currentImage.width)
                            handleSettingChange('height', currentImage.height)
                            handleSettingChange('alt', currentImage.alt)
                            handleSettingChange('variation', currentImage.variation)
                        }
                    }}
                    aria-label="Reset image settings to original values"
                >
                    <RotateCcw size={18} strokeWidth={2} />
                    Reset
                </button>
                <button
                    className="btn btn-primary"
                    onClick={applyChanges}
                    aria-label="Apply image setting changes"
                >
                    <Check size={18} strokeWidth={2} />
                    Apply
                </button>
            </div>
        </div>
    )
}

export default ImageSettings
