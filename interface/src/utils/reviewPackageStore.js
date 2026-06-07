const packageFiles = new Map()

function normalizePackagePath(pathValue) {
    if (!pathValue) return ''

    let normalized = String(pathValue).split('?')[0].replace(/\\/g, '/')
    normalized = normalized.replace(/^\/+/, '')

    if (normalized.startsWith('redundant-review/')) {
        normalized = normalized.slice('redundant-review/'.length)
    }

    return normalized
}

export function clearReviewPackageStore() {
    packageFiles.clear()
}

export function setReviewPackageFile(pathValue, blob) {
    const normalizedPath = normalizePackagePath(pathValue)
    if (!normalizedPath || !blob) return
    packageFiles.set(normalizedPath, blob)
}

export function hasReviewPackageFiles() {
    return packageFiles.size > 0
}

export function getReviewPackageFile(pathValue) {
    const normalizedPath = normalizePackagePath(pathValue)
    if (!normalizedPath) return null

    // Never resolve remote URLs or original-package paths from uploaded output.
    if (/^https?:\/\//i.test(String(pathValue)) || normalizedPath.includes('original-packages')) {
        return null
    }

    if (packageFiles.has(normalizedPath)) {
        return packageFiles.get(normalizedPath)
    }

    const withoutStructurePrefix = normalizedPath.startsWith('structure/')
        ? normalizedPath.slice('structure/'.length)
        : null

    if (withoutStructurePrefix && packageFiles.has(withoutStructurePrefix)) {
        return packageFiles.get(withoutStructurePrefix)
    }

    const withStructurePrefix = normalizedPath.startsWith('structure/')
        ? normalizedPath
        : `structure/${normalizedPath}`

    if (packageFiles.has(withStructurePrefix)) {
        return packageFiles.get(withStructurePrefix)
    }

    const fileName = normalizedPath.split('/').pop()
    if (fileName && packageFiles.has(fileName)) {
        return packageFiles.get(fileName)
    }

    return null
}

export function resolveReviewPackagePaths(item) {
    const candidates = [
        item?.zip_path,
        item?.zip_url,
        item?.question_id ? `structure/${item.question_id}.zip` : null,
        item?.question_id ? `${item.question_id}.zip` : null,
    ].filter(Boolean)

    return [...new Set(candidates.map(normalizePackagePath).filter(Boolean))]
}
