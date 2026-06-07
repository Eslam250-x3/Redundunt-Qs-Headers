import JSZip from 'jszip'
import { REVIEW_CONFIG } from '../constants'
import {
    getReviewPackageFile,
    hasReviewPackageFiles,
    resolveReviewPackagePaths,
} from './reviewPackageStore'

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp']

function extractImageReferences(jsonData) {
    const imageRefs = new Set()

    const searchForImages = (obj) => {
        if (!obj) return

        if (typeof obj === 'string') {
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

    const questions = Array.isArray(jsonData) ? jsonData : [jsonData]
    questions.forEach(question => {
        if (question.content && question.content.parts) {
            searchForImages(question.content.parts)
        }
        searchForImages(question)
    })

    return Array.from(imageRefs)
}

function fixImageReferences(jsonString, imageCorrections) {
    let fixedString = jsonString
    for (const [oldName, newName] of Object.entries(imageCorrections)) {
        const escapedOldName = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const regex1 = new RegExp(`(["'])${escapedOldName}\\1`, 'g')
        fixedString = fixedString.replace(regex1, `$1${newName}$1`)
        const regexEscaped = new RegExp(`(\\\\")(${escapedOldName})\\\\"`, 'g')
        fixedString = fixedString.replace(regexEscaped, `$1${newName}\\"`)
    }
    return fixedString
}

function enhanceImageTags(jsonString, imageDimensions) {
    const imgTagRegex = /<img([^>]*?)\/?>/gi
    const replacements = []
    let match

    while ((match = imgTagRegex.exec(jsonString)) !== null) {
        const fullTag = match[0]
        const attributes = match[1]
        const srcMatch = attributes.match(/src=(?:\\["']|["'])([^"'\\]+)(?:\\["']|["'])/i)
        if (!srcMatch) continue

        const imageSrc = srcMatch[1]
        const altMatch = attributes.match(/alt=(?:\\["']|["'])([^"'\\]*)(?:\\["']|["'])/i)
        const alt = altMatch ? altMatch[1] : ''

        let width
        let height
        const existingWidth = attributes.match(/width=(?:\\["']|["'])([^"'\\]+)(?:\\["']|["'])/i)
        const existingHeight = attributes.match(/height=(?:\\["']|["'])([^"'\\]+)(?:\\["']|["'])/i)

        if (existingWidth && existingHeight) {
            width = existingWidth[1]
            height = existingHeight[1]
        } else if (imageDimensions[imageSrc]) {
            width = imageDimensions[imageSrc].width
            height = imageDimensions[imageSrc].height
        } else {
            continue
        }

        const isJsonContext = fullTag.includes('\\"') || fullTag.includes("\\'")
        const quote = isJsonContext ? '\\"' : '"'
        const aspectRatio = `aspect-ratio: ${width}/${height};`
        const newImgTag = `<img alt=${quote}${alt}${quote} class=${quote}displayed-image${quote} src=${quote}${imageSrc}${quote} style=${quote}${aspectRatio}${quote} height=${quote}${height}${quote} width=${quote}${width}${quote}/>`
        replacements.push({ old: fullTag, new: newImgTag })
    }

    const replacementMap = new Map()
    replacements.forEach(({ old, new: newTag }) => {
        const escapedOld = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        replacementMap.set(escapedOld, newTag)
    })

    let enhancedString = jsonString
    replacementMap.forEach((newTag, escapedOld) => {
        const regex = new RegExp(escapedOld, 'g')
        enhancedString = enhancedString.replace(regex, newTag)
    })

    return enhancedString
}

async function getImageDimensions(imageBlobs) {
    const dimensions = {}

    for (const [imageName, blobUrl] of Object.entries(imageBlobs)) {
        try {
            const isSvg = imageName.toLowerCase().endsWith('.svg')

            if (isSvg) {
                try {
                    const response = await fetch(blobUrl)
                    const svgText = await response.text()
                    const parser = new DOMParser()
                    const svgDoc = parser.parseFromString(svgText, 'image/svg+xml')
                    const svgElement = svgDoc.querySelector('svg')

                    let width
                    let height

                    if (svgElement) {
                        const widthAttr = svgElement.getAttribute('width')
                        const heightAttr = svgElement.getAttribute('height')

                        if (widthAttr && heightAttr) {
                            width = parseFloat(widthAttr)
                            height = parseFloat(heightAttr)
                        } else {
                            const viewBox = svgElement.getAttribute('viewBox')
                            if (viewBox) {
                                const viewBoxParts = viewBox.split(/[\s,]+/)
                                if (viewBoxParts.length >= 4) {
                                    width = parseFloat(viewBoxParts[2])
                                    height = parseFloat(viewBoxParts[3])
                                }
                            }
                        }
                    }

                    if (width && height && !Number.isNaN(width) && !Number.isNaN(height)) {
                        dimensions[imageName] = { width, height }
                        continue
                    }
                } catch (svgError) {
                    console.warn(`Failed to parse SVG dimensions for ${imageName}:`, svgError)
                }
            }

            const img = new Image()
            await new Promise((resolve) => {
                img.onload = () => {
                    dimensions[imageName] = {
                        width: img.naturalWidth || 220,
                        height: img.naturalHeight || 220,
                    }
                    resolve()
                }
                img.onerror = () => {
                    dimensions[imageName] = { width: 220, height: 220 }
                    resolve()
                }
                img.src = blobUrl
            })
        } catch (error) {
            console.warn(`Failed to get dimensions for ${imageName}:`, error)
            dimensions[imageName] = { width: 220, height: 220 }
        }
    }

    return dimensions
}

export async function loadQuestionsFromZipFile(file) {
    const zip = await JSZip.loadAsync(file)
    const questions = []
    const folderMap = new Map()
    const is12Digits = (str) => /^\d{12}$/.test(str)
    const extractQuestionId = (fileName) => {
        const match = fileName.match(/^(\d{12})/)
        return match ? match[1] : null
    }

    for (const [filePath, zipEntry] of Object.entries(zip.files)) {
        if (zipEntry.dir || filePath.includes('__MACOSX')) continue

        const pathParts = filePath.split('/')
        let folderName
        let fileName

        if (pathParts.length >= 2) {
            folderName = pathParts[0]
            fileName = pathParts[pathParts.length - 1]
            if (!is12Digits(folderName)) continue
        } else {
            fileName = pathParts[0]
            folderName = extractQuestionId(fileName)
            if (!folderName) continue
        }

        if (!folderMap.has(folderName)) {
            folderMap.set(folderName, {
                id: folderName,
                jsonFile: null,
                images: [],
            })
        }

        const folderData = folderMap.get(folderName)

        if (fileName === `${folderName}.json`) {
            folderData.jsonFile = { path: filePath, entry: zipEntry }
        } else if (
            fileName.startsWith(`${folderName}.`) &&
            IMAGE_EXTENSIONS.some(ext => fileName.toLowerCase().endsWith(ext))
        ) {
            folderData.images.push({ path: filePath, entry: zipEntry, name: fileName })
        }
    }

    for (const [questionId, folderData] of folderMap.entries()) {
        try {
            if (!folderData.jsonFile) continue

            let jsonContent = await folderData.jsonFile.entry.async('string')
            let jsonData = JSON.parse(jsonContent)

            const actualImagesMap = new Map()
            folderData.images.forEach(image => {
                const baseName = image.name.replace(/\.[^.]+$/, '')
                actualImagesMap.set(baseName, image.name)
            })

            const imageRefs = extractImageReferences(jsonData)
            const imageCorrections = {}

            for (const imageRef of imageRefs) {
                const baseName = imageRef.replace(/\.[^.]+$/, '')
                if (actualImagesMap.has(baseName)) {
                    const actualFileName = actualImagesMap.get(baseName)
                    if (imageRef !== actualFileName) {
                        imageCorrections[imageRef] = actualFileName
                    }
                }
            }

            if (Object.keys(imageCorrections).length > 0) {
                jsonContent = fixImageReferences(jsonContent, imageCorrections)
                jsonData = JSON.parse(jsonContent)
            }

            const sortedImages = folderData.images.sort((a, b) => a.name.localeCompare(b.name))
            const imageBlobs = {}

            for (const image of sortedImages) {
                try {
                    const imageData = await image.entry.async('arraybuffer')
                    const ext = image.name.split('.').pop().toLowerCase()
                    const mimeTypes = {
                        svg: 'image/svg+xml',
                        png: 'image/png',
                        jpg: 'image/jpeg',
                        jpeg: 'image/jpeg',
                        gif: 'image/gif',
                        webp: 'image/webp',
                        bmp: 'image/bmp',
                    }
                    const mimeType = mimeTypes[ext] || 'image/png'
                    const imageBlob = new Blob([imageData], { type: mimeType })
                    imageBlobs[image.name] = URL.createObjectURL(imageBlob)
                } catch (error) {
                    console.warn(`[${questionId}] Failed to load image ${image.name}:`, error)
                }
            }

            const imageDimensions = await getImageDimensions(imageBlobs)
            const imageRefToDimensions = {}

            for (const imageRef of imageRefs) {
                const correctedName = imageCorrections[imageRef] || imageRef
                const baseName = correctedName.replace(/\.[^.]+$/, '')
                if (actualImagesMap.has(baseName)) {
                    const actualFileName = actualImagesMap.get(baseName)
                    if (imageDimensions[actualFileName]) {
                        imageRefToDimensions[correctedName] = imageDimensions[actualFileName]
                    }
                }
            }

            if (Object.keys(imageRefToDimensions).length > 0) {
                jsonContent = enhanceImageTags(jsonContent, imageRefToDimensions)
                jsonData = JSON.parse(jsonContent)
            }

            questions.push({
                id: questionId,
                data: {
                    ...jsonData,
                    id: questionId,
                },
                filename: folderData.jsonFile.path,
                images: imageBlobs,
            })
        } catch (error) {
            console.warn(`Failed to process folder ${questionId}:`, error)
        }
    }

    return questions
}

async function fetchQuestionsFromZipUrl(zipUrl) {
    const response = await fetch(zipUrl)
    if (!response.ok) {
        throw new Error(`Failed to fetch ${zipUrl}: HTTP ${response.status}`)
    }

    const blob = await response.blob()
    if (!blob.size) {
        throw new Error(`Empty package fetched from ${zipUrl}`)
    }

    const fileName = zipUrl.split('/').pop() || 'question.zip'
    const file = new File([blob], fileName, { type: 'application/zip' })
    return loadQuestionsFromZipFile(file)
}

export async function loadQuestionsFromZipUrl(zipUrl, options = {}) {
    const { useUploadedPackage = true } = options
    const zipUrlString = String(zipUrl)
    const isRemoteUrl = /^https?:\/\//i.test(zipUrlString)

    if (useUploadedPackage && !isRemoteUrl && hasReviewPackageFiles()) {
        const storedBlob = getReviewPackageFile(zipUrlString)
        if (storedBlob) {
            const fileName = zipUrlString.split('/').pop() || 'question.zip'
            const file = storedBlob instanceof File
                ? storedBlob
                : new File([storedBlob], fileName, { type: 'application/zip' })
            return loadQuestionsFromZipFile(file)
        }
    }

    return fetchQuestionsFromZipUrl(zipUrlString)
}

async function loadAfterQuestion(item) {
    const candidatePaths = resolveReviewPackagePaths(item)
    let lastError = null

    for (const candidatePath of candidatePaths) {
        try {
            const questions = await loadQuestionsFromZipUrl(candidatePath)
            if (questions.length > 0) {
                return questions[0]
            }
            lastError = new Error(`No question JSON found in ${candidatePath}`)
        } catch (error) {
            lastError = error
            console.warn(`Failed to load after package from ${candidatePath}:`, error)
        }
    }

    if (lastError) {
        throw lastError
    }

    return null
}

export async function loadBeforeQuestion(item) {
    const candidateUrls = [
        item.original_zip_url?.startsWith('http') ? item.original_zip_url : null,
        item.question_id ? `${REVIEW_CONFIG.s3PackagesBase}/${item.question_id}.zip` : null,
        item.original_zip_url,
        item.question_id ? `/redundant-review/original-packages/${item.question_id}.zip` : null,
        item.question_id ? `/redundant-review-original/${item.question_id}.zip` : null,
    ].filter(Boolean)

    let lastError = null

    for (const url of candidateUrls) {
        try {
            const questions = await loadQuestionsFromZipUrl(url, { useUploadedPackage: false })
            if (questions.length > 0) {
                return questions[0]
            }
            lastError = new Error(`No question JSON found in ${url}`)
        } catch (error) {
            lastError = error
            console.warn(`Failed to load before package from ${url}:`, error)
        }
    }

    if (lastError) {
        throw lastError
    }

    return null
}

export async function loadReviewComparison(item) {
    let before = null
    let beforeError = ''

    try {
        before = await loadBeforeQuestion(item)
    } catch (error) {
        beforeError = error.message || 'Failed to load original package from S3.'
    }

    const after = await loadAfterQuestion(item)

    return {
        questionId: item.question_id,
        before,
        after,
        error: !after
            ? 'Failed to load cleaned package from the uploaded review bundle.'
            : beforeError,
    }
}

export const REVIEW_MANIFEST_URL = REVIEW_CONFIG.manifestUrl

export async function fetchReviewManifest() {
    const response = await fetch(`${REVIEW_MANIFEST_URL}?v=${Date.now()}`)
    if (!response.ok) {
        throw new Error(
            `Review manifest not found. Upload a review package ZIP or run build_review_structure.py locally. (HTTP ${response.status})`,
        )
    }
    return response.json()
}
