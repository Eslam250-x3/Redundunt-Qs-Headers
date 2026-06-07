import { useCallback } from 'react'
import { CheckCircle2, Clock, Copy, FileText, Pause } from 'lucide-react'
import '../QuestionList/QuestionList.css'
import './ReviewQuestionList.css'

function ReviewQuestionList({
    comparisons,
    selectedQuestionId,
    onSelectQuestionId,
    renderingStatus,
}) {
    const scrollToQuestion = useCallback((questionId) => {
        onSelectQuestionId(questionId)
        const element = document.getElementById(`review-${questionId}`)
        element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, [onSelectQuestionId])

    const copyQuestionId = useCallback(async (event, questionId) => {
        event.stopPropagation()
        try {
            await navigator.clipboard.writeText(questionId)
        } catch (error) {
            console.warn('Failed to copy question ID:', error)
        }
    }, [])

    const getStatusIcon = (questionId) => {
        const afterStatus = renderingStatus[`${questionId}-after`]
        const beforeStatus = renderingStatus[`${questionId}-before`]
        const status = afterStatus === 'rendered' || beforeStatus === 'rendered'
            ? 'rendered'
            : afterStatus === 'loading' || beforeStatus === 'loading'
                ? 'loading'
                : 'pending'

        const iconProps = { size: 20, strokeWidth: 2.5 }
        switch (status) {
            case 'rendered':
                return <CheckCircle2 {...iconProps} className="status-success" />
            case 'loading':
                return <Clock {...iconProps} className="status-loading" />
            default:
                return <Pause {...iconProps} className="status-pending" />
        }
    }

    if (comparisons.length === 0) {
        return null
    }

    return (
        <div className="question-list glass-card review-question-list">
            <div className="list-header">
                <div className="list-header-title">
                    <FileText size={22} strokeWidth={2.5} />
                    <h3>Question IDs</h3>
                </div>
                <span className="list-count">{comparisons.length}</span>
            </div>

            <div className="list-container">
                {comparisons.map((comparison, index) => (
                    <div
                        key={comparison.questionId}
                        role="button"
                        tabIndex={0}
                        className={`question-item ${selectedQuestionId === comparison.questionId ? 'selected' : ''}`}
                        onClick={() => scrollToQuestion(comparison.questionId)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                scrollToQuestion(comparison.questionId)
                            }
                        }}
                    >
                        <span className="question-index">{index + 1}</span>
                        <div className="question-info">
                            <span className="question-id">{comparison.questionId}</span>
                            <span className="question-source">Click to jump to comparison</span>
                        </div>
                        <button
                            type="button"
                            className="review-copy-btn"
                            title="Copy question ID"
                            aria-label={`Copy question ID ${comparison.questionId}`}
                            onClick={(event) => copyQuestionId(event, comparison.questionId)}
                        >
                            <Copy size={16} strokeWidth={2.5} />
                        </button>
                        <span className="question-status">
                            {getStatusIcon(comparison.questionId)}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    )
}

export default ReviewQuestionList
