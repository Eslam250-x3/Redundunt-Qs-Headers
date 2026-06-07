import { Image } from 'lucide-react'
import './Header.css'
import '../ReviewPanel/ReviewPanel.css'

function Header({ questionsCount, appMode, onModeChange, reviewOnly = false }) {
    return (
        <header className="header">
            <div className="header-content">
                <div className="header-brand">
                    <div className="logo">
                        <Image className="logo-icon" size={28} strokeWidth={2.5} />
                        <h1>{reviewOnly ? 'Cleanup Review' : 'Graphic Preview'}</h1>
                    </div>
                    <p className="tagline">
                        {reviewOnly
                            ? 'Upload cleaned output ZIP and compare against original packages from S3'
                            : appMode === 'review'
                                ? 'Review cleaned question packages with before/after comparison'
                                : 'Professional Question Preview'}
                    </p>
                </div>

                <div className="header-actions">
                    {!reviewOnly && (
                        <div className="mode-toggle">
                            <button
                                type="button"
                                className={`mode-toggle-btn ${appMode === 'review' ? 'active' : ''}`}
                                onClick={() => onModeChange('review')}
                            >
                                Review
                            </button>
                            <button
                                type="button"
                                className={`mode-toggle-btn ${appMode === 'editor' ? 'active' : ''}`}
                                onClick={() => onModeChange('editor')}
                            >
                                Editor
                            </button>
                        </div>
                    )}

                    {questionsCount > 0 && (
                        <div className="stat-item">
                            <span className="stat-value">{questionsCount}</span>
                            <span className="stat-label">Questions</span>
                        </div>
                    )}
                </div>
            </div>
        </header>
    )
}

export default Header
