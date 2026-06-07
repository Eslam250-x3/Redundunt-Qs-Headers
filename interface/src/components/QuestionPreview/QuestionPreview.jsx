import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react'
import './QuestionPreview.css'
import { ENGINE_CONFIG } from '../../constants'

const QuestionPreview = forwardRef(({ question, height, onRenderStart, label, previewKey, compact = false, missingMessage = 'Original package not available.', displayQuestionId }, ref) => {
    const iframeRef = useRef(null)
    const containerRef = useRef(null)

    // Convert blob URL to base64
    const blobToBase64 = useCallback(async (blobUrl, imageName = '') => {
        try {
            const response = await fetch(blobUrl)
            const blob = await response.blob()

            // For SVG files, ensure correct MIME type
            const isSvg = imageName.toLowerCase().endsWith('.svg')
            const blobToUse = isSvg && blob.type !== 'image/svg+xml'
                ? new Blob([await blob.text()], { type: 'image/svg+xml' })
                : blob

            return new Promise((resolve, reject) => {
                const reader = new FileReader()
                reader.onloadend = () => {
                    console.log(`[Preview] Converted ${imageName} to base64, length: ${reader.result?.length}`)
                    resolve(reader.result)
                }
                reader.onerror = reject
                reader.readAsDataURL(blobToUse)
            })
        } catch (error) {
            console.warn('Failed to convert blob to base64:', error)
            return null
        }
    }, [])

    // Recursively replace image src in object (safe approach - no string manipulation)
    const replaceImageSources = useCallback((obj, base64Map) => {
        if (obj === null || obj === undefined) return obj

        if (typeof obj === 'string') {
            // Check if this string contains img tags with src to replace
            let result = obj
            for (const [imageName, base64] of Object.entries(base64Map)) {
                // Use split/join for safe replacement (no regex special char issues)
                const patterns = [
                    `src="${imageName}"`,
                    `src='${imageName}'`,
                ]
                for (const pattern of patterns) {
                    if (result.includes(pattern)) {
                        console.log(`[Preview] Replacing ${pattern} with base64`)
                        result = result.split(pattern).join(`src="${base64}"`)
                    }
                }

                // Also check if the string contains the image name anywhere (for debugging)
                if (result.includes(imageName) && !result.includes('data:image')) {
                    console.log(`[Preview] Found ${imageName} in string but pattern didn't match. String snippet:`, result.substring(0, 200))
                }
            }
            return result
        }

        if (Array.isArray(obj)) {
            return obj.map(item => replaceImageSources(item, base64Map))
        }

        if (typeof obj === 'object') {
            const newObj = {}
            for (const [key, value] of Object.entries(obj)) {
                newObj[key] = replaceImageSources(value, base64Map)
            }
            return newObj
        }

        return obj
    }, [])

    // Replace image src with base64 in question data
    const embedImagesInQuestion = useCallback(async (questionData, images) => {
        if (!images || Object.keys(images).length === 0) {
            return questionData
        }

        // Convert all blob URLs to base64
        const base64Map = {}
        for (const [imageName, blobUrl] of Object.entries(images)) {
            if (blobUrl.startsWith('blob:')) {
                const base64 = await blobToBase64(blobUrl, imageName)
                if (base64) {
                    base64Map[imageName] = base64
                    console.log(`[Preview] Mapped ${imageName} to base64`)
                }
            }
        }

        // Safely replace image sources using recursive object traversal
        return replaceImageSources(questionData, base64Map)
    }, [blobToBase64, replaceImageSources])

    const initializeQuestion = useCallback(async () => {
        const iframe = iframeRef.current
        if (!iframe || !question) return

        const questionId = question.id
        const renderId = previewKey || questionId

        // Notify parent that rendering started
        onRenderStart?.(renderId)

        // Embed local images as base64 in question data
        const questionData = await embedImagesInQuestion(question.data, question.images)

        // Use empty base path since images are embedded
        const questionBasePath = question.images && Object.keys(question.images).length > 0
            ? '' // Images are embedded as base64
            : `${ENGINE_CONFIG.baseURL}/${questionId}` // Use remote URL for questions without local images

        // Get target origin from engine URL for security
        const engineOrigin = new URL(ENGINE_CONFIG.engineURL).origin

        // Send init message to iframe with explicit targetOrigin
        iframe.contentWindow?.postMessage(
            JSON.stringify({
                action: 'init',
                payload: {
                    question: questionData,
                    assetsBasePath: questionBasePath,
                    mode: ENGINE_CONFIG.mode
                }
            }),
            engineOrigin
        )
    }, [question, onRenderStart, embedImagesInQuestion, previewKey])

    // Expose takeScreenshot to parent
    useImperativeHandle(ref, () => ({
        takeScreenshot: () => {
            const iframe = iframeRef.current
            if (!iframe) return

            const engineOrigin = new URL(ENGINE_CONFIG.engineURL).origin
            iframe.contentWindow?.postMessage(
                JSON.stringify({
                    action: 'takeScreenshot',
                    questionId: question?.id
                }),
                engineOrigin
            )
        }
    }), [question?.id])

    // Track if iframe is loaded
    const iframeLoadedRef = useRef(false)

    useEffect(() => {
        const iframe = iframeRef.current
        if (!iframe) return

        const handleLoad = () => {
            iframeLoadedRef.current = true
            initializeQuestion()
        }

        iframe.addEventListener('load', handleLoad)

        return () => {
            iframe.removeEventListener('load', handleLoad)
        }
    }, [initializeQuestion])

    // Re-initialize when question data changes (after iframe is loaded)
    useEffect(() => {
        if (iframeLoadedRef.current && question?.data) {
            initializeQuestion()
        }
    }, [question?.data, initializeQuestion])

    // Update iframe key when question ID changes to force reload
    const iframeKey = previewKey || question?.id || 'empty'

    const shownQuestionId = question?.id || displayQuestionId

    const questionIdBar = shownQuestionId ? (
        <div className="preview-question-id-bar">
            <span className="preview-question-id-label">Question ID</span>
            <span className="preview-question-id-value">{shownQuestionId}</span>
        </div>
    ) : null

    if (!question) {
        return (
            <div className={`question-preview glass-card fade-in ${compact ? 'question-preview-compact' : ''}`}>
                <div className="preview-header">
                    <div className="preview-title">
                        <span className="preview-icon">👁️</span>
                        <h3>{label || 'Question Preview'}</h3>
                    </div>
                </div>
                {questionIdBar}
                <div className="preview-missing">
                    <p>{missingMessage}</p>
                </div>
            </div>
        )
    }

    return (
        <div className={`question-preview glass-card fade-in ${compact ? 'question-preview-compact' : ''}`} ref={containerRef}>
            <div className="preview-header">
                <div className="preview-title">
                    <span className="preview-icon">👁️</span>
                    <h3>{label || 'Question Preview'}</h3>
                </div>
                {!compact && (
                    <div className="preview-info">
                        <span className="question-badge">{shownQuestionId}</span>
                    </div>
                )}
            </div>

            {questionIdBar}

            <div
                className="iframe-container"
                style={{ height: height ? `${height + 50}px` : 'auto', minHeight: compact ? '420px' : '500px' }}
            >
                <iframe
                    key={iframeKey}
                    ref={iframeRef}
                    src={ENGINE_CONFIG.engineURL}
                    title={`Question ${question.id}`}
                    className="question-iframe"
                />
            </div>

            {!compact && question.images && Object.keys(question.images).length > 0 && (
                <div className="images-section">
                    <h4 className="images-title">📷 Images</h4>
                    <div className="images-grid">
                        {Object.entries(question.images).map(([imageName, imageUrl]) => (
                            <div key={imageName} className="image-item">
                                <img
                                    src={imageUrl}
                                    alt={imageName}
                                    className="question-image"
                                    loading="lazy"
                                    onError={(e) => {
                                        console.warn(`Failed to load image: ${imageName}`)
                                        e.target.style.display = 'flex'
                                        e.target.style.alignItems = 'center'
                                        e.target.style.justifyContent = 'center'
                                        e.target.textContent = '🖼️'
                                    }}
                                />
                                <span className="image-name">{imageName}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {!compact && (
            <div className="preview-footer">
                <div className="footer-info">
                    <span className="info-label">Engine:</span>
                    <span className="info-value">Nagwa Questions Engine</span>
                </div>
                <div className="footer-info">
                    <span className="info-label">Mode:</span>
                    <span className="info-value">{ENGINE_CONFIG.mode}</span>
                </div>
            </div>
            )}
        </div>
    )
});

export default QuestionPreview
