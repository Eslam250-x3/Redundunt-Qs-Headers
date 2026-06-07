import QuestionPreview from '../QuestionPreview/QuestionPreview'
import './ReviewComparison.css'

function ReviewComparison({ comparison, onRenderStart, isHighlighted = false }) {
    const { questionId, before, after, error } = comparison
    const beforeError = !before && error ? error : ''

    return (
        <div
            id={`review-${questionId}`}
            className={`review-comparison glass-card ${isHighlighted ? 'review-comparison-highlight' : ''}`}
        >
            <div className="review-comparison-header">
                <span className="question-badge">{questionId}</span>
                {error && !before && after && (
                    <span className="review-comparison-error">{error}</span>
                )}
                {error && !after && (
                    <span className="review-comparison-error">{error}</span>
                )}
            </div>

            <div className="review-comparison-grid">
                <QuestionPreview
                    question={before}
                    label="Before"
                    previewKey={`${questionId}-before`}
                    displayQuestionId={questionId}
                    compact
                    missingMessage={beforeError || 'Original package not available.'}
                    onRenderStart={onRenderStart}
                />
                <QuestionPreview
                    question={after}
                    label="After"
                    previewKey={`${questionId}-after`}
                    displayQuestionId={questionId}
                    compact
                    onRenderStart={onRenderStart}
                />
            </div>
        </div>
    )
}

export default ReviewComparison
