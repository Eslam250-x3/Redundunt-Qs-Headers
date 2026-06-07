import JSZip from 'jszip'
import {
    clearReviewPackageStore,
    setReviewPackageFile,
} from './reviewPackageStore'

const MANIFEST_CANDIDATES = [
    'structure/manifest.json',
    'manifest.json',
]

function isQuestionZipPath(pathValue) {
    return /\/(\d{12})\.zip$/.test(pathValue) || /^(\d{12})\.zip$/.test(pathValue)
}

function isManifestPath(pathValue) {
    return pathValue.endsWith('manifest.json')
}

export async function loadReviewPackageFromZipFile(file) {
    const archive = await JSZip.loadAsync(file)
    clearReviewPackageStore()

    let manifest = null
    let manifestPath = ''
    let questionZipCount = 0

    for (const [entryPath, zipEntry] of Object.entries(archive.files)) {
        if (zipEntry.dir || entryPath.includes('__MACOSX')) continue

        const normalizedPath = entryPath.replace(/\\/g, '/').replace(/^\/+/, '')

        if (isManifestPath(normalizedPath) && !manifest) {
            manifestPath = normalizedPath
            manifest = JSON.parse(await zipEntry.async('string'))
            continue
        }

        if (isQuestionZipPath(normalizedPath)) {
            const blob = await zipEntry.async('blob')
            setReviewPackageFile(normalizedPath, blob)
            questionZipCount += 1
        }
    }

    if (!manifest) {
        for (const candidate of MANIFEST_CANDIDATES) {
            const zipEntry = archive.file(candidate)
            if (!zipEntry) continue

            manifestPath = candidate
            manifest = JSON.parse(await zipEntry.async('string'))
            break
        }
    }

    if (!manifest) {
        throw new Error(
            'Review package must include manifest.json or structure/manifest.json.',
        )
    }

    if (questionZipCount === 0) {
        throw new Error(
            'Review package does not contain any question ZIP files.',
        )
    }

    return {
        manifest,
        manifestPath,
        questionZipCount,
        fileName: file.name,
    }
}

export async function loadReviewManifestFromFile(file) {
    const content = await file.text()
    const manifest = JSON.parse(content)

    return {
        manifest,
        manifestPath: file.name,
        questionZipCount: 0,
        fileName: file.name,
    }
}
