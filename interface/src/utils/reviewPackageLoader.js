import JSZip from 'jszip'
import {
    clearReviewPackageStore,
    setReviewPackageFile,
} from './reviewPackageStore'

const MANIFEST_CANDIDATES = [
    'structure/manifest.json',
    'manifest.json',
]

function normalizeArchivePath(pathValue) {
    return String(pathValue).replace(/\\/g, '/').replace(/^\/+/, '')
}

function isQuestionZipPath(pathValue) {
    return /(?:^|\/)(\d{12})\.zip$/i.test(pathValue)
}

function isManifestPath(pathValue) {
    return pathValue.toLowerCase().endsWith('manifest.json')
}

function extractQuestionId(pathValue) {
    const match = pathValue.match(/(\d{12})\.zip$/i)
    return match ? match[1] : null
}

function buildQuestionEntry(normalizedPath) {
    const questionId = extractQuestionId(normalizedPath)
    if (!questionId) return null

    const pathParts = normalizedPath.split('/')
    pathParts.pop()

    if (pathParts[0]?.toLowerCase() === 'structure') {
        pathParts.shift()
    }

    let subject = 'All Questions'
    let grade = 'All'

    if (pathParts.length >= 2) {
        subject = pathParts[pathParts.length - 2]
        grade = pathParts[pathParts.length - 1]
    } else if (pathParts.length === 1) {
        grade = pathParts[0]
    }

    return {
        question_id: questionId,
        status: 'fixed',
        zip_path: normalizedPath,
        zip_url: normalizedPath,
        subject,
        grade,
    }
}

function buildManifestFromQuestionPaths(questionPaths) {
    const grouped = new Map()

    for (const pathValue of questionPaths) {
        const entry = buildQuestionEntry(pathValue)
        if (!entry) continue

        if (!grouped.has(entry.subject)) {
            grouped.set(entry.subject, new Map())
        }

        const grades = grouped.get(entry.subject)
        if (!grades.has(entry.grade)) {
            grades.set(entry.grade, [])
        }

        grades.get(entry.grade).push({
            question_id: entry.question_id,
            status: entry.status,
            zip_path: entry.zip_path,
            zip_url: entry.zip_url,
        })
    }

    const subjects = [...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([subjectName, gradesMap]) => {
            const grades = [...gradesMap.entries()]
                .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
                .map(([gradeName, questions]) => ({
                    name: gradeName,
                    folder: gradeName,
                    question_count: questions.length,
                    questions: questions.sort((left, right) =>
                        left.question_id.localeCompare(right.question_id),
                    ),
                }))

            return {
                name: subjectName,
                folder: subjectName,
                question_count: grades.reduce((total, grade) => total + grade.question_count, 0),
                grades,
            }
        })

    const totalQuestions = subjects.reduce((total, subject) => total + subject.question_count, 0)

    return {
        generated_at: new Date().toISOString(),
        total_questions: totalQuestions,
        auto_generated: true,
        subjects,
    }
}

export async function loadReviewPackageFromZipFile(file) {
    const archive = await JSZip.loadAsync(file)
    clearReviewPackageStore()

    let manifest = null
    let manifestPath = ''
    const questionPaths = []

    for (const [entryPath, zipEntry] of Object.entries(archive.files)) {
        if (zipEntry.dir || entryPath.includes('__MACOSX')) continue

        const normalizedPath = normalizeArchivePath(entryPath)

        if (isManifestPath(normalizedPath) && !manifest) {
            manifestPath = normalizedPath
            manifest = JSON.parse(await zipEntry.async('string'))
            continue
        }

        if (isQuestionZipPath(normalizedPath)) {
            const blob = await zipEntry.async('blob')
            setReviewPackageFile(normalizedPath, blob)
            questionPaths.push(normalizedPath)
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

    if (questionPaths.length === 0) {
        throw new Error(
            'Review package does not contain any question ZIP files. Expected files like 185143938323.zip inside the archive.',
        )
    }

    if (!manifest) {
        manifest = buildManifestFromQuestionPaths(questionPaths)
        manifestPath = 'auto-generated/manifest.json'
    }

    return {
        manifest,
        manifestPath,
        questionZipCount: questionPaths.length,
        fileName: file.name,
        autoGeneratedManifest: Boolean(manifest.auto_generated),
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
        autoGeneratedManifest: false,
    }
}
