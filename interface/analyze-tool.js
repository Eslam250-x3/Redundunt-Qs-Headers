/**
 * 🔍 Graphic Editor Tool - Automated Analysis Script
 * 
 * This script analyzes the codebase for common issues and potential bugs.
 * Run with: node analyze-tool.js
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';

// ANSI colors for terminal output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m',
};

const log = {
    critical: (msg) => console.log(`${colors.red}${colors.bold}🔴 CRITICAL: ${msg}${colors.reset}`),
    major: (msg) => console.log(`${colors.yellow}${colors.bold}🟠 MAJOR: ${msg}${colors.reset}`),
    minor: (msg) => console.log(`${colors.cyan}🟡 MINOR: ${msg}${colors.reset}`),
    info: (msg) => console.log(`${colors.blue}🔵 INFO: ${msg}${colors.reset}`),
    success: (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
    header: (msg) => console.log(`\n${colors.bold}${colors.magenta}═══════════════════════════════════════${colors.reset}`),
};

// Issue counters
const issues = {
    critical: [],
    major: [],
    minor: [],
    info: [],
};

// Get all JS/JSX files recursively
function getJSFiles(dir, files = []) {
    if (!existsSync(dir)) return files;

    const items = readdirSync(dir);
    for (const item of items) {
        const path = join(dir, item);
        const stat = statSync(path);

        if (stat.isDirectory() && !item.includes('node_modules') && !item.startsWith('.')) {
            getJSFiles(path, files);
        } else if (stat.isFile() && (item.endsWith('.js') || item.endsWith('.jsx'))) {
            files.push(path);
        }
    }
    return files;
}

// Analysis functions
const analyzers = {
    // Track blob URLs across all files (project-wide check)
    _projectBlobCreate: 0,
    _projectBlobRevoke: 0,
    _blobCreateFiles: [],
    _blobRevokeFiles: [],

    // Check for memory leaks with Blob URLs (project-wide)
    checkBlobURLLeaks(content, filename) {
        const createCount = (content.match(/URL\.createObjectURL/g) || []).length;
        const revokeCount = (content.match(/URL\.revokeObjectURL/g) || []).length;

        if (createCount > 0) {
            this._projectBlobCreate += createCount;
            this._blobCreateFiles.push(filename);
        }
        if (revokeCount > 0) {
            this._projectBlobRevoke += revokeCount;
            this._blobRevokeFiles.push(filename);
        }
    },

    // Check for useState initializer issues
    checkStaleClosures(content, filename) {
        // Pattern: useState with initializer function using external variable
        const stateInitPattern = /useState\(\(\)\s*=>\s*\{[\s\S]*?\}\)/g;
        const matches = content.matchAll(stateInitPattern);

        for (const match of matches) {
            // Check if useMemo/useCallback result is used in initializer
            if (match[0].includes('extracted') || match[0].includes('computed') || match[0].includes('derived')) {
                issues.critical.push({
                    file: filename,
                    issue: 'Potential stale closure in useState initializer',
                    details: 'useState initializer runs only once, but uses computed value that may change',
                    line: this.findLine(content, match[0].substring(0, 50)),
                });
            }
        }
    },

    // Check for JSON string manipulation
    checkUnsafeJSONManipulation(content, filename) {
        const stringifyPattern = /JSON\.stringify\([^)]+\)/g;
        const replaceAfterPattern = /JSON\.stringify[\s\S]{0,200}\.replace\(/g;

        if (replaceAfterPattern.test(content)) {
            issues.major.push({
                file: filename,
                issue: 'Unsafe JSON string manipulation',
                details: 'Using regex replace on JSON strings can corrupt data',
                line: this.findLine(content, 'JSON.stringify'),
            });
        }
    },

    // Check for unhandled async calls
    checkUnhandledAsync(content, filename) {
        const asyncFuncs = content.match(/const\s+\w+\s*=\s*useCallback\(\s*async/g) || [];
        const asyncCalls = content.match(/\(\)\s*(?:=>)?\s*\{\s*\n?\s*\w+\(\)/g) || [];

        // Check for async functions called without await or .catch
        const unhandledPattern = /^\s+(?!await\s+)(\w+)\(\)/gm;
        const functionBodies = content.match(/const\s+\w+\s*=[\s\S]*?(?=\nconst|\nexport|\nfunction|$)/g) || [];

        for (const body of functionBodies) {
            if (body.includes('async') && body.includes('()') && !body.includes('.catch') && !body.includes('try')) {
                const funcName = body.match(/const\s+(\w+)/)?.[1];
                if (funcName && body.match(new RegExp(`${funcName}\\(\\)(?!\\s*\\.catch)`))) {
                    issues.major.push({
                        file: filename,
                        issue: 'Async function called without error handling',
                        details: `Function may silently fail`,
                        line: this.findLine(content, funcName),
                    });
                }
            }
        }
    },

    // Check for array index bounds issues
    checkArrayBoundsIssues(content, filename) {
        // Pattern: array[index] where index is from useState
        const indexPattern = /\[selectedIndex\]|\[selectedImageIndex\]|\[currentIndex\]/g;
        const hasIndexState = /useState\(\s*0\s*\)/g.test(content);

        if (indexPattern.test(content) && hasIndexState) {
            // Check if there's a bounds check or reset when data changes
            if (!content.includes('Math.min') && !content.includes('% ')) {
                issues.major.push({
                    file: filename,
                    issue: 'Potential array index out of bounds',
                    details: 'Array accessed with index that may exceed length after data change',
                    line: this.findLine(content, 'selectedIndex') || this.findLine(content, 'selectedImageIndex'),
                });
            }
        }
    },

    // Check for missing error handling
    checkMissingErrorHandling(content, filename) {
        const fetchCalls = (content.match(/await\s+fetch\(/g) || []).length;
        const tryCatches = (content.match(/try\s*\{/g) || []).length;

        if (fetchCalls > tryCatches) {
            issues.major.push({
                file: filename,
                issue: 'Fetch calls may lack error handling',
                details: `${fetchCalls} fetch calls but only ${tryCatches} try-catch blocks`,
                line: this.findLine(content, 'fetch('),
            });
        }
    },

    // Check for missing PropTypes
    checkMissingPropTypes(content, filename) {
        const isComponent = /^function\s+[A-Z]|^const\s+[A-Z]\w+\s*=/.test(content);
        const hasProps = /\(\s*\{\s*\w+/.test(content);
        const hasPropTypes = /PropTypes|\.propTypes/.test(content);
        const hasTypeScript = /:\s*(React\.FC|Props|Types)/.test(content);

        if (isComponent && hasProps && !hasPropTypes && !hasTypeScript) {
            issues.minor.push({
                file: filename,
                issue: 'Component missing PropTypes',
                details: 'Consider adding PropTypes or TypeScript for type safety',
                line: 1,
            });
        }
    },

    // Check for hardcoded URLs
    checkHardcodedURLs(content, filename) {
        const urlPattern = /(https?:\/\/[^\s'"]+)/g;
        const matches = content.match(urlPattern) || [];
        const hardcodedURLs = matches.filter(url =>
            !url.includes('localhost') &&
            !url.includes('example.com') &&
            !url.includes('placeholder')
        );

        if (hardcodedURLs.length > 0) {
            issues.minor.push({
                file: filename,
                issue: 'Hardcoded URLs found',
                details: `Consider using environment variables: ${hardcodedURLs[0].substring(0, 50)}...`,
                line: this.findLine(content, hardcodedURLs[0].substring(0, 30)),
            });
        }
    },

    // Check for accessibility issues
    checkAccessibility(content, filename) {
        const buttons = (content.match(/<button/g) || []).length;
        const ariaLabels = (content.match(/aria-label/g) || []).length;
        const titles = (content.match(/title=/g) || []).length;

        if (buttons > (ariaLabels + titles)) {
            issues.minor.push({
                file: filename,
                issue: 'Potential accessibility issue',
                details: `${buttons} buttons but only ${ariaLabels + titles} have aria-label or title`,
                line: this.findLine(content, '<button'),
            });
        }
    },

    // Check for magic numbers
    checkMagicNumbers(content, filename) {
        // Find numbers that appear more than twice and aren't common values
        const magicPattern = /:\s*(\d{2,4})(?!\s*px|\s*rem|\s*em|\s*%|\s*ms|\s*s\b)/g;
        const numbers = {};
        let match;

        while ((match = magicPattern.exec(content)) !== null) {
            const num = match[1];
            if (!['100', '200', '300', '400', '500'].includes(num)) {
                numbers[num] = (numbers[num] || 0) + 1;
            }
        }

        for (const [num, count] of Object.entries(numbers)) {
            if (count >= 3) {
                issues.minor.push({
                    file: filename,
                    issue: `Magic number ${num} used ${count} times`,
                    details: 'Consider defining as a named constant',
                    line: this.findLine(content, num),
                });
            }
        }
    },

    // Check for missing loading states
    checkMissingLoadingStates(content, filename) {
        const hasAsync = /async|await|\.then\(/.test(content);
        const hasLoadingState = /isLoading|loading|setLoading/.test(content);

        if (hasAsync && !hasLoadingState && /export default/.test(content)) {
            issues.minor.push({
                file: filename,
                issue: 'Async operations without loading indicator',
                details: 'Consider adding loading state for better UX',
                line: this.findLine(content, 'async') || this.findLine(content, '.then'),
            });
        }
    },

    // Check for potential XSS
    checkPotentialXSS(content, filename) {
        // Check for dangerouslySetInnerHTML or string interpolation in JSX
        const dangerousPattern = /dangerouslySetInnerHTML|innerHTML\s*=/g;
        const templateInJSX = /\${[^}]+}/g;

        if (dangerousPattern.test(content)) {
            issues.major.push({
                file: filename,
                issue: 'Potential XSS vulnerability',
                details: 'Using dangerouslySetInnerHTML or innerHTML without sanitization',
                line: this.findLine(content, 'innerHTML'),
            });
        }

        // Check for unsanitized user input in HTML strings
        if (/`<\w+[^>]*\${settings\.|user\.|input\./.test(content)) {
            issues.major.push({
                file: filename,
                issue: 'Unsanitized user input in HTML template',
                details: 'User input should be sanitized before inserting into HTML',
                line: this.findLine(content, '${settings') || this.findLine(content, '${input'),
            });
        }
    },

    // Check for inefficient re-renders
    checkIneffientRerenders(content, filename) {
        // Check for useMemo/useCallback with object dependencies
        const memoPattern = /use(?:Memo|Callback)\([^,]+,\s*\[(question|data|items|props)\]\)/g;

        if (memoPattern.test(content)) {
            issues.info.push({
                file: filename,
                issue: 'Memoization with object dependency',
                details: 'Object references change on every render, consider deep comparison',
                line: this.findLine(content, 'useMemo') || this.findLine(content, 'useCallback'),
            });
        }
    },

    // Check for missing error boundaries
    checkMissingErrorBoundaries(content, filename) {
        if (filename.includes('App.jsx') || filename.includes('App.js')) {
            if (!content.includes('ErrorBoundary') && !content.includes('componentDidCatch')) {
                issues.info.push({
                    file: filename,
                    issue: 'No Error Boundary in App',
                    details: 'A component error will crash the entire application',
                    line: 1,
                });
            }
        }
    },

    // Helper to find line number
    findLine(content, searchStr) {
        const index = content.indexOf(searchStr);
        if (index === -1) return null;
        return content.substring(0, index).split('\n').length;
    },
};

// Run analysis
function analyze() {
    console.log(`${colors.bold}${colors.magenta}`);
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║     🔍 Graphic Editor Tool - Automated Analysis          ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(colors.reset);

    const srcDir = join(process.cwd(), 'src');
    const files = getJSFiles(srcDir);

    console.log(`\n📁 Scanning ${files.length} files...\n`);

    for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        const filename = basename(file);

        console.log(`  Analyzing: ${colors.cyan}${filename}${colors.reset}`);

        // Run all analyzers
        for (const [name, fn] of Object.entries(analyzers)) {
            if (typeof fn === 'function' && name !== 'findLine') {
                try {
                    fn.call(analyzers, content, filename);
                } catch (e) {
                    console.error(`Error in ${name}:`, e.message);
                }
            }
        }
    }

    // Project-wide blob URL leak check
    if (analyzers._projectBlobCreate > 0 && analyzers._projectBlobRevoke === 0) {
        issues.critical.push({
            file: analyzers._blobCreateFiles.join(', '),
            issue: 'Blob URLs created but never revoked in entire project',
            details: `Found ${analyzers._projectBlobCreate} createObjectURL calls but no revokeObjectURL anywhere`,
            line: null,
        });
    } else if (analyzers._projectBlobCreate > 0 && analyzers._projectBlobRevoke > 0) {
        // Blob URLs are handled - no issue
        console.log(`  ${colors.green}✓${colors.reset} Blob URLs: ${analyzers._projectBlobCreate} created, cleanup in ${analyzers._blobRevokeFiles.join(', ')}`);
    }

    // Print results
    log.header();
    console.log(`\n${colors.bold}📊 ANALYSIS RESULTS${colors.reset}\n`);

    // Critical issues
    if (issues.critical.length > 0) {
        console.log(`\n${colors.red}${colors.bold}🔴 CRITICAL ISSUES (${issues.critical.length})${colors.reset}\n`);
        for (const issue of issues.critical) {
            console.log(`  ${colors.red}●${colors.reset} ${colors.bold}${issue.file}${colors.reset}${issue.line ? `:${issue.line}` : ''}`);
            console.log(`    ${issue.issue}`);
            console.log(`    ${colors.cyan}${issue.details}${colors.reset}\n`);
        }
    }

    // Major issues
    if (issues.major.length > 0) {
        console.log(`\n${colors.yellow}${colors.bold}🟠 MAJOR ISSUES (${issues.major.length})${colors.reset}\n`);
        for (const issue of issues.major) {
            console.log(`  ${colors.yellow}●${colors.reset} ${colors.bold}${issue.file}${colors.reset}${issue.line ? `:${issue.line}` : ''}`);
            console.log(`    ${issue.issue}`);
            console.log(`    ${colors.cyan}${issue.details}${colors.reset}\n`);
        }
    }

    // Minor issues
    if (issues.minor.length > 0) {
        console.log(`\n${colors.cyan}🟡 MINOR ISSUES (${issues.minor.length})${colors.reset}\n`);
        for (const issue of issues.minor) {
            console.log(`  ${colors.cyan}●${colors.reset} ${issue.file}${issue.line ? `:${issue.line}` : ''}`);
            console.log(`    ${issue.issue}`);
            console.log(`    ${issue.details}\n`);
        }
    }

    // Info
    if (issues.info.length > 0) {
        console.log(`\n${colors.blue}🔵 SUGGESTIONS (${issues.info.length})${colors.reset}\n`);
        for (const issue of issues.info) {
            console.log(`  ${colors.blue}●${colors.reset} ${issue.file}: ${issue.issue}`);
        }
    }

    // Summary
    log.header();
    console.log(`\n${colors.bold}📋 SUMMARY${colors.reset}`);
    console.log(`  🔴 Critical: ${issues.critical.length}`);
    console.log(`  🟠 Major:    ${issues.major.length}`);
    console.log(`  🟡 Minor:    ${issues.minor.length}`);
    console.log(`  🔵 Info:     ${issues.info.length}`);

    const total = issues.critical.length + issues.major.length + issues.minor.length + issues.info.length;
    console.log(`\n  ${colors.bold}Total: ${total} issues found${colors.reset}\n`);

    // Exit code
    if (issues.critical.length > 0) {
        console.log(`${colors.red}❌ Analysis failed - critical issues found${colors.reset}\n`);
        process.exit(1);
    } else if (issues.major.length > 0) {
        console.log(`${colors.yellow}⚠️ Analysis completed with warnings${colors.reset}\n`);
        process.exit(0);
    } else {
        console.log(`${colors.green}✅ Analysis passed!${colors.reset}\n`);
        process.exit(0);
    }
}

// Run
analyze();
