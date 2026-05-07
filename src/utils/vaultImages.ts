import { isTauri } from '../mock-tauri'
import {
  attachmentAssetUrlFromPath,
  isCurrentVaultAssetUrl,
  isPortableAttachmentPath,
  isTauriAssetUrl,
  portableAttachmentPathFromAnyAssetUrl,
  portableAttachmentPathFromCurrentVaultAssetUrl,
  vaultAttachmentAssetUrl,
} from './vaultAttachments'

type Markdown = string
type VaultPath = string
type NotePath = string
type AbsolutePath = string
type MarkdownImageUrl = string
type RelativeUrl = string

const LOCALHOST_ASSET_URL_PREFIX = 'asset://localhost/'
const HTTP_ASSET_URL_PREFIX = 'http://asset.localhost/'
const GENERIC_ASSET_URL_PREFIX = 'asset://'
const ASSET_URL_PREFIXES = [
  LOCALHOST_ASSET_URL_PREFIX,
  HTTP_ASSET_URL_PREFIX,
  GENERIC_ASSET_URL_PREFIX,
]
const WINDOWS_EXTENDED_PATH_PREFIX = '\\\\?\\'
const WINDOWS_EXTENDED_UNC_PREFIX = '\\\\?\\UNC\\'
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

// Matches markdown image syntax: ![alt](url) or ![alt](url "title").
// URL group is non-greedy so a trailing ` "title"` (when present) wins the match
// — that lets URLs contain raw spaces while still recognizing optional titles.
const MD_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)"]+?)(\s+"[^"]*")?\)/g

function rewriteMarkdownImages(
  markdown: Markdown,
  transformUrl: (url: MarkdownImageUrl) => MarkdownImageUrl | null,
): Markdown {
  return markdown.replace(MD_IMAGE_PATTERN, (match, alt, url, title = '') => {
    const nextUrl = transformUrl(url)
    return nextUrl ? `![${alt}](${nextUrl}${title})` : match
  })
}

function usesWindowsSeparators(path: string): boolean {
  return WINDOWS_DRIVE_PATH_PATTERN.test(path) || path.startsWith('\\\\')
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || WINDOWS_DRIVE_PATH_PATTERN.test(path) || path.startsWith('\\\\')
}

function hasUrlScheme(url: string): boolean {
  return URL_SCHEME_PATTERN.test(url)
}

function withoutTrailingSlash(path: AbsolutePath): AbsolutePath {
  return path.replace(/\/+$/, '')
}

function removeWindowsExtendedPrefix(path: AbsolutePath): AbsolutePath {
  if (path.startsWith(WINDOWS_EXTENDED_UNC_PREFIX)) {
    return `\\\\${path.slice(WINDOWS_EXTENDED_UNC_PREFIX.length)}`
  }
  if (path.startsWith(WINDOWS_EXTENDED_PATH_PREFIX)) {
    return path.slice(WINDOWS_EXTENDED_PATH_PREFIX.length)
  }
  return path
}

function normalizedFilesystemPath(path: AbsolutePath): AbsolutePath {
  return removeWindowsExtendedPrefix(path).replace(/\\/g, '/')
}

function noteDirectoryPath(notePath: NotePath): AbsolutePath {
  const idx = Math.max(notePath.lastIndexOf('/'), notePath.lastIndexOf('\\'))
  if (idx === -1) return '.'
  if (idx === 0) return notePath.charAt(0)
  return notePath.slice(0, idx)
}

function decodeRelativeUrl(url: RelativeUrl): RelativeUrl {
  // CommonMark allows URL-encoded characters; tolerate malformed input.
  try {
    return decodeURI(url)
  } catch {
    return url
  }
}

function joinNoteRelativePath(noteDir: AbsolutePath, relativeUrl: RelativeUrl): AbsolutePath {
  const useBackslash = usesWindowsSeparators(noteDir)
  const decoded = decodeRelativeUrl(relativeUrl)
  const noteDirNormalized = withoutTrailingSlash(noteDir.replace(/\\/g, '/'))
  const relativeNormalized = decoded.replace(/\\/g, '/')
  const dirSegments = noteDirNormalized.split('/')
  for (const seg of relativeNormalized.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (dirSegments.length > 1) dirSegments.pop()
      continue
    }
    dirSegments.push(seg)
  }
  const joined = dirSegments.join('/')
  return useBackslash ? joined.replace(/\//g, '\\') : joined
}

function relativeFromNoteDirectory(
  noteDir: AbsolutePath,
  absolutePath: AbsolutePath,
): RelativeUrl | null {
  const noteDirNormalized = withoutTrailingSlash(normalizedFilesystemPath(noteDir))
  const absNormalized = normalizedFilesystemPath(absolutePath)

  if (absNormalized.startsWith(`${noteDirNormalized}/`)) {
    return `./${absNormalized.slice(noteDirNormalized.length + 1)}`
  }

  const dirSegs = noteDirNormalized.split('/')
  const absSegs = absNormalized.split('/')
  let common = 0
  while (
    common < dirSegs.length &&
    common < absSegs.length &&
    dirSegs[common] === absSegs[common]
  ) common++
  if (common === 0) return null

  const ups = '../'.repeat(dirSegs.length - common)
  const downs = absSegs.slice(common).join('/')
  return `${ups}${downs}`
}

function decodeAssetUrl(url: MarkdownImageUrl): AbsolutePath {
  const prefix = ASSET_URL_PREFIXES.find(p => url.startsWith(p))
  if (!prefix) return ''
  const raw = url.slice(prefix.length)
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    decoded = raw
  }
  return isAbsolutePath(decoded) ? decoded : `/${decoded}`
}

function noteRelativeFromAssetUrl(
  url: MarkdownImageUrl,
  notePath: NotePath,
): RelativeUrl | null {
  const absolutePath = decodeAssetUrl(url)
  if (!absolutePath) return null
  return relativeFromNoteDirectory(noteDirectoryPath(notePath), absolutePath)
}

export function resolveImageUrls(
  markdown: Markdown,
  vaultPath: VaultPath,
  notePath?: NotePath,
): Markdown {
  if (!isTauri() || !vaultPath) return markdown

  return rewriteMarkdownImages(markdown, (url) => {
    if (isPortableAttachmentPath({ path: url })) {
      return vaultAttachmentAssetUrl({ vaultPath, attachmentPath: url })
    }

    if (isTauriAssetUrl({ url })) {
      if (isCurrentVaultAssetUrl({ url, vaultPath })) return null
      const attachmentPath = portableAttachmentPathFromAnyAssetUrl({ url })
      return attachmentPath ? vaultAttachmentAssetUrl({ vaultPath, attachmentPath }) : null
    }

    if (hasUrlScheme(url)) return null

    if (isAbsolutePath(url)) {
      return attachmentAssetUrlFromPath({ path: decodeRelativeUrl(url) })
    }

    if (notePath) {
      return attachmentAssetUrlFromPath({
        path: joinNoteRelativePath(noteDirectoryPath(notePath), url),
      })
    }

    return null
  })
}

export function portableImageUrls(
  markdown: Markdown,
  vaultPath: VaultPath,
  notePath?: NotePath,
): Markdown {
  if (!vaultPath) return markdown

  return rewriteMarkdownImages(markdown, (url) => {
    if (!isTauriAssetUrl({ url })) return null

    const attachmentPath = portableAttachmentPathFromCurrentVaultAssetUrl({ url, vaultPath })
    if (attachmentPath) return attachmentPath

    if (notePath) {
      const noteRelative = noteRelativeFromAssetUrl(url, notePath)
      if (noteRelative) return noteRelative
    }

    // Fall back to the absolute filesystem path so saved markdown
    // never carries the internal asset:// scheme.
    const absolutePath = decodeAssetUrl(url)
    return absolutePath || null
  })
}
