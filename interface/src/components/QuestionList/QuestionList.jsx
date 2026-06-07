import { CheckCircle2, Clock, XCircle, Pause, FileText } from 'lucide-react'
import './QuestionList.css'

function QuestionList({ questions, selectedQuestion, onSelectQuestion, renderingStatus }) {
    const getStatusIcon = (status) => {
        const iconProps = { size: 20, strokeWidth: 2.5 }
        switch (status) {
            case 'rendered':
                return <CheckCircle2 {...iconProps} />
            case 'loading':
                return <Clock {...iconProps} />
            case 'error':
                return <XCircle {...iconProps} />
            default:
                return <Pause {...iconProps} />
        }
    }

    const getStatusClass = (status) => {
        switch (status) {
            case 'rendered':
                return 'status-success'
            case 'loading':
                return 'status-loading'
            case 'error':
                return 'status-error'
            default:
                return 'status-pending'
        }
    }

    return (
        <div className="question-list glass-card">
            <div className="list-header">
                <div className="list-header-title">
                    <FileText size={22} strokeWidth={2.5} />
                    <h3>Questions</h3>
                </div>
                <span className="list-count">{questions.length}</span>
            </div>

            <div className="list-container">
                {questions.map((question, index) => (
                    <button
                        key={question.id}
                        className={`question-item ${selectedQuestion?.id === question.id ? 'selected' : ''}`}
                        onClick={() => onSelectQuestion(question)}
                    >
                        <span className="question-index">{index + 1}</span>
                        <div className="question-info">
                            <span className="question-id">{question.id}</span>
                            {question.filename && (
                                <span className="question-source">{question.filename}</span>
                            )}
                        </div>
                        <span className={`question-status ${getStatusClass(renderingStatus[question.id])}`}>
                            {getStatusIcon(renderingStatus[question.id])}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    )
}

export default QuestionList
