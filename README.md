# Zip Viewer - VS Code Extension

A VS Code extension that allows you to browse and extract various compressed archive file formats directly within the editor.

![Demo](https://github.com/t-fuchi/zip-viewer/releases/download/zip_viewer/demo.gif)

## Supported Formats

### ZIP Format
* `.zip` - Including password-protected archives

### 7-Zip Format
* `.7z` - Including password-protected archives

### TAR Format (Uncompressed)
* `.tar`

### GZIP Compressed TAR
* `.tar.gz`
* `.tgz`

### XZ Compressed TAR
* `.tar.xz`

### BZIP2 Compressed TAR
* `.tar.bz2`
* `.tbz2`
* `.tz2`

### Compress Compressed TAR
* `.tar.Z`
* `.taz`
* `.taZ`

### LZIP Compressed TAR
* `.tar.lz`
* `.tlz`

### LZMA Compressed TAR
* `.tar.lzma`

### Zstandard Compressed TAR
* `.tar.zst`
* `.tzst`

## Features

### 📁 File List Display
* Display file names, sizes, and timestamps
* Tree view for directory hierarchy
* Expandable and collapsible folders
* Folder expand/collapse state is preserved when switching tabs

### 👁️ File Preview
* Mouse down on file names to preview content; release to close
* Preview first lines of text files
* Customizable preview line count in settings

### 🖼️ Image Preview
* Inline preview for JPG, PNG, GIF, WebP, BMP, SVG, ICO, TIFF, and AVIF files

### 📝 Markdown Preview
* Rendered Markdown preview with inline image rendering
* Images referenced inside the archive are embedded automatically
* Click to toggle preview open/closed; navigate between Markdown files with arrow keys
* Supported in ZIP, TAR, and 7Z formats

### 📦 Nested Archive Preview
* Clicking an archive file inside an archive (e.g. a `.zip` inside a `.tar.gz`) shows its file listing

### 🔐 Password Protection Support
* Support for password-protected ZIP and 7Z files
* Password remembered for the same file during session

### 📤 File & Folder Extraction
* Right-click to extract individual files
* Right-click to extract entire folders
* Select multiple items with checkboxes for batch extraction
* Choose custom extraction destination

## How to Use

1. Open a compressed file (.zip, .7z, .tar.gz, etc.) in VS Code
2. The file list will be displayed
3. Click folder icons to expand hierarchy
4. Mouse down on file names to preview content (release to close); click Markdown files to toggle preview and use arrow keys to navigate
5. Right-click to extract files/folders, or use checkboxes for batch extraction

## Settings

Customize the preview line count in `settings.json`:

```json
{
  "zipViewer.previewLineCount": 20
}
```

Default is 20 lines.

## Advertising

This extension may display advertisements in designated advertising spaces within the interface. Revenue from advertisements is used for the development, maintenance, and improvement of the extension. Advertisements are displayed discreetly and do not interfere with the core functionality of the extension.

## Privacy

This extension operates entirely locally and does not transmit your files or data externally. All processing is performed on your computer.

## Limitations

* Very large archive files may take time to load
* Binary file previews may not display correctly
* LZO format (`.tar.lzo`) is not currently supported

## Dependencies

* `unzipper` - ZIP format support
* `7zip-bin` - 7Z format support
* `node-7z` - 7-Zip binary interface
* `tar` - TAR format support
* `lzma-native` - XZ/LZMA compression support
* `unbzip2-stream` - BZIP2 compression support
* `@mongodb-js/zstd` - Zstandard compression support
* `markdown-it` - Markdown rendering

## License

This software is provided under a proprietary license. The source code is closed and unauthorized copying, distribution, or modification is prohibited. Use of this extension is subject to the VS Code Marketplace Terms of Use.

Copyright (c) 2024 Takeshi Fuchi. All rights reserved.

## Support

For issues or feature requests, please contact us through the review section or support link on the VS Code Marketplace.

## Privacy Policy

Zip Viewer does not collect, store, or transmit any user data...


## Version History

### 2.1.3
* Filter out `.` and `..` entries from archive file listing (ZIP/TAR/7Z)

### 2.1.2
* Fix demo.gif URL in README

### 2.1.1
* Update extension name and add repository field

### 2.1.0
* Added batch extraction for multiple files and folders
* Added Markdown preview with inline image rendering (ZIP/TAR/7Z)
* Added image preview (JPG/PNG/GIF/WebP/BMP/SVG/ICO/TIFF/AVIF)
* Added Zstandard (`.tar.zst` / `.tzst`) format support
* Added nested archive file listing (click an archive inside an archive to browse it)
* Added password protection support for 7Z
* Markdown preview with click-to-toggle and arrow-key navigation
* Webview state retention (folder expand/collapse preserved across tab switches)
* UI improvements and performance optimization
* Added 7Z format support

### 2.0.0
* Support for 17 compression formats
* UI improvements (VS Code theme color support)
* Thousand separator display for file sizes

### 1.0.0
* Initial release
* Support for ZIP, TAR, TAR.GZ, TAR.XZ, TAR.BZ2
