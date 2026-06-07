import { useState, useCallback, useEffect, useRef } from 'react'
import './App.css'
import Header from './components/Header/Header'
import QuestionInput from './components/QuestionInput/QuestionInput'
import QuestionList from './components/QuestionList/QuestionList'
import QuestionPreview from './components/QuestionPreview/QuestionPreview'
import ImageSettings from './components/ImageSettings/ImageSettings'
import ExportPanel from './components/ExportPanel/ExportPanel'
import ReviewPanel from './components/ReviewPanel/ReviewPanel'
import ReviewComparison from './components/ReviewComparison/ReviewComparison'
import ReviewQuestionList from './components/ReviewQuestionList/ReviewQuestionList'
import { TRUSTED_ORIGINS, REVIEW_CONFIG } from './constants'

function collectComparisonQuestions(comparisons) {
  return comparisons.flatMap(comparison => [comparison.before, comparison.after].filter(Boolean))
}

function App() {
  const [appMode, setAppMode] = useState(REVIEW_CONFIG.reviewOnly ? 'review' : 'review')
  const [questions, setQuestions] = useState([])
  const [selectedQuestion, setSelectedQuestion] = useState(null)
  const [questionHeights, setQuestionHeights] = useState({})
  const [renderingStatus, setRenderingStatus] = useState({})
  const [reviewComparisons, setReviewComparisons] = useState([])
  const [reviewSelectionLabel, setReviewSelectionLabel] = useState('')
  const [selectedReviewQuestionId, setSelectedReviewQuestionId] = useState('')
  const [isReviewLoading, setIsReviewLoading] = useState(false)
  const previewRef = useRef(null)
  const screenshotResolverRef = useRef(null)
  const renderResolverRef = useRef(null)

  useEffect(() => {
    const handleMessage = (event) => {
      const isFromTrustedOrigin = TRUSTED_ORIGINS.some(origin =>
        event.origin === origin || event.origin.startsWith(origin)
      )
      if (!isFromTrustedOrigin) {
        return
      }

      try {
        const data = JSON.parse(event.data)
        const { messageKey, questionId, questionHeight, screenshotData } = data

        if (messageKey === 'screenshotResult' && screenshotData) {
          if (screenshotResolverRef.current) {
            screenshotResolverRef.current(screenshotData)
            screenshotResolverRef.current = null
            return
          }

          const link = document.createElement('a')
          link.href = screenshotData
          link.download = `${questionId || 'screenshot'}.png`
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          return
        }

        if (['questionRendered', 'questionHeightChanged'].includes(messageKey)) {
          setQuestionHeights(prev => ({
            ...prev,
            [questionId]: questionHeight
          }))

          if (messageKey === 'questionRendered') {
            setRenderingStatus(prev => ({
              ...prev,
              [questionId]: 'rendered'
            }))

            if (renderResolverRef.current && renderResolverRef.current.questionId === questionId) {
              renderResolverRef.current.resolve()
              renderResolverRef.current = null
            }
          }
        }
      } catch {
        // Ignore non-JSON messages
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  const blobUrlsRef = useRef(new Set())

  useEffect(() => {
    const activeQuestions = appMode === 'review'
      ? collectComparisonQuestions(reviewComparisons)
      : questions

    activeQuestions.forEach(q => {
      if (q.images) {
        Object.values(q.images).forEach(url => {
          if (url.startsWith('blob:')) {
            blobUrlsRef.current.add(url)
          }
        })
      }
    })
  }, [questions, reviewComparisons, appMode])

  useEffect(() => {
    const urlsRef = blobUrlsRef
    return () => {
      urlsRef.current.forEach(url => {
        URL.revokeObjectURL(url)
      })
      urlsRef.current.clear()
    }
  }, [])

  const revokeOldBlobUrls = useCallback((oldQuestions) => {
    oldQuestions.forEach(q => {
      if (q.images) {
        Object.values(q.images).forEach(url => {
          if (url.startsWith('blob:')) {
            URL.revokeObjectURL(url)
            blobUrlsRef.current.delete(url)
          }
        })
      }
    })
  }, [])

  const handleQuestionsLoaded = useCallback((loadedQuestions) => {
    setQuestions(prevQuestions => {
      revokeOldBlobUrls(prevQuestions)
      return loadedQuestions
    })

    setSelectedQuestion(null)
    setQuestionHeights({})

    const initialStatus = {}
    loadedQuestions.forEach(q => {
      initialStatus[q.id] = 'pending'
    })
    setRenderingStatus(initialStatus)
  }, [revokeOldBlobUrls])

  const handleReviewComparisonsLoaded = useCallback((updater) => {
    setReviewComparisons(prevComparisons => {
      const nextComparisons = typeof updater === 'function' ? updater(prevComparisons) : updater
      const prevQuestions = collectComparisonQuestions(prevComparisons)
      const nextQuestions = collectComparisonQuestions(nextComparisons)
      const nextIds = new Set(nextQuestions.map(question => question.id))

      revokeOldBlobUrls(prevQuestions.filter(question => !nextIds.has(question.id)))

      setRenderingStatus(prevStatus => {
        const nextStatus = { ...prevStatus }
        nextComparisons.forEach(comparison => {
          const beforeKey = `${comparison.questionId}-before`
          const afterKey = `${comparison.questionId}-after`
          if (!nextStatus[beforeKey]) nextStatus[beforeKey] = 'pending'
          if (!nextStatus[afterKey]) nextStatus[afterKey] = 'pending'
        })
        return nextStatus
      })

      return nextComparisons
    })
  }, [revokeOldBlobUrls])

  useEffect(() => {
    if (appMode !== 'review') {
      return
    }

    setSelectedReviewQuestionId(prevSelected => {
      if (reviewComparisons.some(comparison => comparison.questionId === prevSelected)) {
        return prevSelected
      }
      return reviewComparisons[0]?.questionId || ''
    })
  }, [reviewComparisons, appMode])

  const handleSelectQuestion = useCallback((question) => {
    setSelectedQuestion(question)
  }, [])

  const handleQuestionRenderStart = useCallback((renderId) => {
    setRenderingStatus(prev => ({
      ...prev,
      [renderId]: 'loading'
    }))
  }, [])

  const handleUpdateQuestion = useCallback((updatedQuestion) => {
    const updateList = (list) => list.map(q =>
      q.id === updatedQuestion.id ? updatedQuestion : q
    )

    setQuestions(updateList)
    setReviewComparisons(prevComparisons => prevComparisons.map(comparison => ({
      ...comparison,
      before: comparison.before?.id === updatedQuestion.id ? updatedQuestion : comparison.before,
      after: comparison.after?.id === updatedQuestion.id ? updatedQuestion : comparison.after,
    })))
    setSelectedQuestion(updatedQuestion)
  }, [])

  const requestScreenshot = useCallback(() => {
    return new Promise((resolve) => {
      if (!previewRef.current) {
        resolve(null)
        return
      }

      screenshotResolverRef.current = resolve
      previewRef.current.takeScreenshot()

      setTimeout(() => {
        if (screenshotResolverRef.current === resolve) {
          screenshotResolverRef.current = null
          resolve(null)
        }
      }, 5000)
    })
  }, [])

  const waitForRender = useCallback((targetQuestionId) => {
    return new Promise((resolve) => {
      renderResolverRef.current = { resolve, questionId: targetQuestionId }
      setTimeout(() => {
        if (renderResolverRef.current?.resolve === resolve) {
          renderResolverRef.current = null
          resolve()
        }
      }, 5000)
    })
  }, [])

  const activeCount = appMode === 'review'
    ? reviewComparisons.length
    : questions.length

  return (
    <div className="app">
      <Header
        questionsCount={activeCount}
        appMode={appMode}
        onModeChange={setAppMode}
        reviewOnly={REVIEW_CONFIG.reviewOnly}
      />

      <main className="main-content">
        <aside className="sidebar">
          {appMode === 'review' ? (
            <>
              <ReviewPanel
                onQuestionsLoaded={handleReviewComparisonsLoaded}
                onLoadingChange={setIsReviewLoading}
                onSelectionChange={setReviewSelectionLabel}
              />

              <ReviewQuestionList
                comparisons={reviewComparisons}
                selectedQuestionId={selectedReviewQuestionId}
                onSelectQuestionId={setSelectedReviewQuestionId}
                renderingStatus={renderingStatus}
              />
            </>
          ) : (
            <QuestionInput onQuestionsLoaded={handleQuestionsLoaded} />
          )}

          {appMode === 'editor' && questions.length > 0 && (
            <QuestionList
              questions={questions}
              selectedQuestion={selectedQuestion}
              onSelectQuestion={handleSelectQuestion}
              renderingStatus={renderingStatus}
            />
          )}

          {appMode === 'editor' && selectedQuestion && (
            <ImageSettings
              key={selectedQuestion.id}
              question={selectedQuestion}
              onUpdateQuestion={handleUpdateQuestion}
            />
          )}

          {appMode === 'editor' && questions.length > 0 && (
            <ExportPanel
              questions={questions}
              selectedQuestion={selectedQuestion}
              requestScreenshot={requestScreenshot}
              onSelectQuestion={handleSelectQuestion}
              waitForRender={waitForRender}
            />
          )}
        </aside>

        <section className="preview-section">
          {appMode === 'review' ? (
            reviewComparisons.length > 0 ? (
              <div className="review-stack">
                <div className="review-stack-header glass-card">
                  <div>
                    <h2>{reviewSelectionLabel || 'Review Selection'}</h2>
                    <p>{reviewComparisons.length} question(s) loaded. Before and after shown side by side.</p>
                  </div>
                  {isReviewLoading && <span>Loading more questions...</span>}
                </div>

                {reviewComparisons.map(comparison => (
                  <ReviewComparison
                    key={comparison.questionId}
                    comparison={comparison}
                    isHighlighted={selectedReviewQuestionId === comparison.questionId}
                    onRenderStart={handleQuestionRenderStart}
                  />
                ))}
              </div>
            ) : (
              <div className="preview-placeholder">
                <div className="placeholder-icon">📚</div>
                <h3>Upload Review Package</h3>
                <p>Upload the output review ZIP, choose subject and grade, then load questions to compare before and after cleanup.</p>
              </div>
            )
          ) : selectedQuestion ? (
            <QuestionPreview
              ref={previewRef}
              question={selectedQuestion}
              height={questionHeights[selectedQuestion.id]}
              onRenderStart={handleQuestionRenderStart}
            />
          ) : questions.length > 0 ? (
            <div className="preview-placeholder">
              <div className="placeholder-icon">👈</div>
              <h3>Select a Question</h3>
              <p>Click on any question from the sidebar to preview it</p>
            </div>
          ) : (
            <div className="preview-placeholder">
              <div className="placeholder-icon">📤</div>
              <h3>Start Loading Questions</h3>
              <p>Upload a JSON or ZIP file containing questions</p>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

export default App
