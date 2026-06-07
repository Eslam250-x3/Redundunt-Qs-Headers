import { useCallback, useState } from 'react'
import JSZip from 'jszip'
import { Download, FileArchive, Package, FileText } from 'lucide-react'
import './ExportPanel.css'

function ExportPanel({ questions, selectedQuestion, requestScreenshot, onSelectQuestion, waitForRender }) {
    const [isExporting, setIsExporting] = useState(false)

    // Safe recursive object traversal to update image src
    const updateImageSrcInObject = useCallback((obj, renameMap) => {
        if (obj === null || obj === undefined) return obj

        if (typeof obj === 'string') {
            // Find and replace image src in HTML strings
            let result = obj
            for (const [oldName, newName] of Object.entries(renameMap)) {
                // Use split/join for safe replacement (no regex special char issues)
                const patterns = [
                    `src="${oldName}"`,
                    `src='${oldName}'`,
                ]
                for (const pattern of patterns) {
                    if (result.includes(pattern)) {
                        const replacement = pattern.replace(oldName, newName)
                        result = result.split(pattern).join(replacement)
                    }
                }
            }
            return result
        }

        if (Array.isArray(obj)) {
            return obj.map(item => updateImageSrcInObject(item, renameMap))
        }

        if (typeof obj === 'object') {
            const newObj = {}
            for (const [key, value] of Object.entries(obj)) {
                newObj[key] = updateImageSrcInObject(value, renameMap)
            }
            return newObj
        }

        return obj
    }, [])

    // Helper function to rename images by extension
    // Input: { "825149592181.01.jpg": blobUrl, "825149592181.02.jpg": blobUrl, "825149592181.03.png": blobUrl }
    // Output: { oldName: newName } mapping and updated JSON
    const renameImagesByExtension = useCallback((question) => {
        const images = question.images || {}
        const questionId = question.id

        // Group images by extension
        const imagesByExt = {}
        const imageNames = Object.keys(images).sort() // Sort for consistent ordering

        for (const imageName of imageNames) {
            const ext = imageName.split('.').pop().toLowerCase()
            if (!imagesByExt[ext]) {
                imagesByExt[ext] = []
            }
            imagesByExt[ext].push(imageName)
        }

        // Create rename mapping: oldName -> newName
        const renameMap = {}
        for (const [ext, names] of Object.entries(imagesByExt)) {
            names.forEach((oldName, index) => {
                const newIndex = String(index + 1).padStart(2, '0')
                const newName = `${questionId}.${newIndex}.${ext}`
                renameMap[oldName] = newName
            })
        }

        // Update data using safe object traversal (not JSON.stringify().replace())
        const updatedData = updateImageSrcInObject(question.data, renameMap)

        // Create new images object with renamed keys
        const renamedImages = {}
        for (const [oldName, blobUrl] of Object.entries(images)) {
            const newName = renameMap[oldName] || oldName
            renamedImages[newName] = blobUrl
        }

        return {
            renameMap,
            updatedData,
            renamedImages
        }
    }, [updateImageSrcInObject])

    // Download selected question as JSON
    const downloadSelectedJSON = useCallback(() => {
        if (!selectedQuestion) return

        const jsonContent = JSON.stringify(selectedQuestion.data, null, 2)
        const blob = new Blob([jsonContent], { type: 'application/json' })
        const url = URL.createObjectURL(blob)

        const link = document.createElement('a')
        link.href = url
        link.download = `${selectedQuestion.id}.json`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
    }, [selectedQuestion])

    // Download all questions as single JSON array
    const downloadAllJSON = useCallback(() => {
        if (questions.length === 0) return

        const allData = questions.map(q => q.data)
        const jsonContent = JSON.stringify(allData, null, 2)
        const blob = new Blob([jsonContent], { type: 'application/json' })
        const url = URL.createObjectURL(blob)

        const link = document.createElement('a')
        link.href = url
        link.download = `questions_${Date.now()}.json`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
    }, [questions])

    // Download all questions as ZIP
    // Structure: main ZIP contains per question: questionId.png (loose) + questionId.zip (JSON + images)
    const downloadAllAsZIP = useCallback(async () => {
        if (questions.length === 0 || isExporting) return

        setIsExporting(true)
        const originalSelected = selectedQuestion
        try {
            const mainZip = new JSZip()

            for (const question of questions) {
                const questionId = question.id

                // Inner ZIP: JSON + question images (no screenshot)
                const questionZip = new JSZip()
                const { updatedData, renamedImages } = renameImagesByExtension(question)
                const jsonContent = JSON.stringify(updatedData, null, 2)
                questionZip.file(`${questionId}.json`, jsonContent)

                for (const [newImageName, blobUrl] of Object.entries(renamedImages)) {
                    try {
                        const response = await fetch(blobUrl)
                        const blob = await response.blob()
                        questionZip.file(newImageName, blob)
                    } catch (error) {
                        console.warn(`Failed to add image ${newImageName}:`, error)
                    }
                }

                const questionZipBlob = await questionZip.generateAsync({ type: 'blob' })
                mainZip.file(`${questionId}.zip`, questionZipBlob)

                // Screenshot at root level (loose)
                let screenshotData = null
                if (selectedQuestion?.id === questionId) {
                    screenshotData = await requestScreenshot()
                } else {
                    onSelectQuestion(question)
                    await waitForRender(questionId)
                    screenshotData = await requestScreenshot()
                }
                if (screenshotData) {
                    try {
                        const response = await fetch(screenshotData)
                        const blob = await response.blob()
                        mainZip.file(`${questionId}.png`, blob)
                    } catch (error) {
                        console.warn(`Failed to add screenshot for ${questionId}:`, error)
                    }
                }
            }

            const zipBlob = await mainZip.generateAsync({ type: 'blob' })
            const url = URL.createObjectURL(zipBlob)
            const link = document.createElement('a')
            link.href = url
            link.download = `questions_export_${Date.now()}.zip`
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)
            URL.revokeObjectURL(url)
        } finally {
            if (originalSelected && originalSelected.id !== selectedQuestion?.id) {
                onSelectQuestion(originalSelected)
            }
            setIsExporting(false)
        }
    }, [questions, renameImagesByExtension, isExporting, requestScreenshot, onSelectQuestion, waitForRender, selectedQuestion])

    // Download selected question with images as ZIP
    // Structure: main ZIP contains screenshot.png (loose) + questionId.zip (JSON + images)
    const downloadSelectedAsZIP = useCallback(async () => {
        if (!selectedQuestion || isExporting) return

        setIsExporting(true)
        try {
            const mainZip = new JSZip()
            const questionId = selectedQuestion.id

            // Inner ZIP: JSON + question images (no screenshot)
            const questionZip = new JSZip()

            const { updatedData, renamedImages } = renameImagesByExtension(selectedQuestion)
            const jsonContent = JSON.stringify(updatedData, null, 2)
            questionZip.file(`${questionId}.json`, jsonContent)

            for (const [newImageName, blobUrl] of Object.entries(renamedImages)) {
                try {
                    const response = await fetch(blobUrl)
                    const blob = await response.blob()
                    questionZip.file(newImageName, blob)
                } catch (error) {
                    console.warn(`Failed to add image ${newImageName}:`, error)
                }
            }

            const questionZipBlob = await questionZip.generateAsync({ type: 'blob' })
            mainZip.file(`${questionId}.zip`, questionZipBlob)

            // Screenshot at root level (loose)
            const screenshotData = await requestScreenshot()
            if (screenshotData) {
                try {
                    const response = await fetch(screenshotData)
                    const blob = await response.blob()
                    mainZip.file(`${questionId}.png`, blob)
                } catch (error) {
                    console.warn(`Failed to add screenshot for ${questionId}:`, error)
                }
            }

            const zipBlob = await mainZip.generateAsync({ type: 'blob' })
            const url = URL.createObjectURL(zipBlob)
            const link = document.createElement('a')
            link.href = url
            link.download = `${questionId}.zip`
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)
            URL.revokeObjectURL(url)
        } finally {
            setIsExporting(false)
        }
    }, [selectedQuestion, renameImagesByExtension, isExporting, requestScreenshot])

    const hasQuestions = questions.length > 0
    const hasSelected = !!selectedQuestion
    const hasImages = selectedQuestion?.images && Object.keys(selectedQuestion.images).length > 0

    return (
        <div className="export-panel glass-card">
            <div className="export-header">
                <Package className="export-icon" size={24} strokeWidth={2} />
                <h4>Export</h4>
                {isExporting && <span className="export-loading">⏳</span>}
            </div>

            <div className="export-section">
                <h5 className="section-title">Selected Question</h5>
                <div className="export-buttons">
                    <button
                        className="btn btn-export"
                        onClick={downloadSelectedJSON}
                        disabled={!hasSelected || isExporting}
                        aria-label="Download current question as JSON"
                    >
                        {isExporting ? '⏳' : <Download size={18} strokeWidth={2} />}
                        JSON
                    </button>
                    <button
                        className="btn btn-export"
                        onClick={downloadSelectedAsZIP}
                        disabled={!hasSelected || isExporting}
                        title="Download selected question with images as ZIP"
                        aria-label="Download selected question with images as ZIP archive"
                    >
                        {isExporting ? '⏳' : <FileArchive size={18} strokeWidth={2} />}
                        ZIP
                        {hasImages && <span className="badge">+Img</span>}
                    </button>
                </div>
            </div>

            <div className="export-divider"></div>

            <div className="export-section">
                <h5 className="section-title">All Questions ({questions.length})</h5>
                <div className="export-buttons">
                    <button
                        className="btn btn-export btn-full"
                        onClick={downloadAllJSON}
                        disabled={!hasQuestions}
                        title="Download all questions as single JSON file"
                        aria-label="Download all questions as single JSON file"
                    >
                        <FileText size={18} strokeWidth={2} />
                        All as JSON
                    </button>
                    <button
                        className="btn btn-export btn-primary btn-full"
                        onClick={downloadAllAsZIP}
                        disabled={!hasQuestions || isExporting}
                        title="Download all questions with images as ZIP"
                        aria-label="Download all questions with images as ZIP archive"
                    >
                        {isExporting ? '⏳' : <Package size={18} strokeWidth={2} />}
                        {isExporting ? 'Exporting...' : 'All as ZIP'}
                    </button>
                </div>
            </div>
        </div>
    )
}

export default ExportPanel
