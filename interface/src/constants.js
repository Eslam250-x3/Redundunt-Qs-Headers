/**
 * Shared constants for the Graphic Editor application
 */

// Trusted origins for postMessage security
export const TRUSTED_ORIGINS = [
    'https://beta-classes-resources.nagwa.com',
    'https://classes-resources.nagwa.com',
]

// Engine configuration
export const ENGINE_CONFIG = {
    engineURL: import.meta.env.VITE_ENGINE_URL || 'https://beta-classes-resources.nagwa.com/engines/unzipped/nagwa_questions_engine/index.html',
    baseURL: import.meta.env.VITE_BASE_URL || 'https://s3.us-east-1.amazonaws.com/beta-qms.nagwa.com/questions',
    mode: 'session_student'
}

export const REVIEW_CONFIG = {
    reviewOnly: import.meta.env.VITE_REVIEW_ONLY === 'true',
    s3PackagesBase: import.meta.env.VITE_S3_PACKAGES_BASE || 'https://s3.us-east-1.amazonaws.com/qms.nagwa.com/packages',
    manifestUrl: import.meta.env.VITE_REVIEW_MANIFEST_URL || '/redundant-review/structure/manifest.json',
}

// Image dimension constraints
export const IMAGE_CONSTRAINTS = {
    MIN_WIDTH: 50,
    MAX_WIDTH: 2000,
    MIN_HEIGHT: 50,
    MAX_HEIGHT: 2000,
}
