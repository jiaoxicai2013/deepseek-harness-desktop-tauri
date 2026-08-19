#!/usr/bin/env node
/**
 * Generate the DeepSeek Harness Local app icon: a dark display showing the
 * official DeepSeek whale logo in white (黑 + 白).
 *
 * Steps:
 *  1. load the official logo path (simple-icons DeepSeek, viewBox 0 0 24 24)
 *  2. compose the monitor SVG
 *  3. render 1024x1024 with @resvg/resvg-js, then auto-center the logo by
 *     scanning the rendered pixels for the ink bbox (no visual preview needed)
 *  4. write src-tauri/icons/icon-source.png (the tauri icon source)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const iconsDir = join(root, 'src-tauri', 'icons')

// 1. Official DeepSeek logo path
const official = readFileSync(join(here, '..', '..', 'deepseek-harness', 'assets') === '' ? '/tmp/deepseek-official.svg' : '/tmp/deepseek-official.svg', 'utf8')
const match = official.match(/<path[^>]*d="([^"]+)"/)
if (!match) throw new Error('logo path not found')
const LOGO_PATH = match[1]
console.log('[gen] logo path', LOGO_PATH.length)

const S = 1024
const SCALE = 14.6 // logo size in canvas px = 24 * 14.6 ~= 350

function svg(tx, ty) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#232833"/>
      <stop offset="1" stop-color="#0c0f15"/>
    </linearGradient>
    <linearGradient id="bezel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a4250"/>
      <stop offset="1" stop-color="#222833"/>
    </linearGradient>
    <linearGradient id="screen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#181d26"/>
      <stop offset="1" stop-color="#05070a"/>
    </linearGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.42" r="0.78">
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.4"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <rect width="1024" height="1024" fill="url(#vignette)"/>
  <!-- monitor bezel -->
  <rect x="160" y="130" width="704" height="640" rx="52" fill="url(#bezel)"/>
  <!-- inner screen -->
  <rect x="224" y="194" width="576" height="512" rx="20" fill="url(#screen)"/>
  <!-- screen top glass highlight -->
  <rect x="232" y="202" width="560" height="10" rx="5" fill="#ffffff" opacity="0.07"/>
  <!-- official DeepSeek logo, white -->
  <g transform="translate(${tx} ${ty}) scale(${SCALE}) translate(-12 -12)">
    <path d="${LOGO_PATH}" fill="#ffffff"/>
  </g>
  <!-- stand -->
  <rect x="476" y="770" width="72" height="84" rx="18" fill="url(#bezel)"/>
  <rect x="356" y="846" width="312" height="46" rx="23" fill="url(#bezel)"/>
  <rect x="356" y="852" width="312" height="8" rx="4" fill="#ffffff" opacity="0.06"/>
</svg>`
}

function render(svgText) {
  const resvg = new Resvg(svgText, { fitTo: { mode: 'width', value: S }, background: '#00000000' })
  return resvg.render()
}

/** Ink bbox of the bright logo pixels inside the screen area. */
function logoBBox(png) {
  // Materialize the pixel buffer ONCE: png.pixels is a lazy getter that
  // re-copies the whole image on every access (4 MB per read), which would
  // make the scan effectively hang.
  const px = png.pixels
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
  for (let y = 200; y < 700; y++) {
    for (let x = 230; x < 795; x++) {
      const i = (y * png.width + x) * 4
      const r = px[i], g = px[i + 1], b = px[i + 2]
      if (r > 180 && g > 180 && b > 180) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX + 1, h: maxY - minY + 1 }
}

const SCREEN_CX = 512
const SCREEN_CY = 450

// Initial render
console.log('[gen] building svg')
let tx = SCREEN_CX, ty = SCREEN_CY
console.log('[gen] rendering initial')
let png = render(svg(tx, ty))
console.log('[gen] rendered', png.width)
let bbox = logoBBox(png)
console.log('initial bbox:', JSON.stringify(bbox))

// Auto-center: adjust translate by the measured ink-center delta.
if (bbox) {
  console.log('[gen] centering by', (SCREEN_CX - bbox.cx).toFixed(1), (SCREEN_CY - bbox.cy).toFixed(1))
  tx += SCREEN_CX - bbox.cx
  ty += SCREEN_CY - bbox.cy
  png = render(svg(tx, ty))
  bbox = logoBBox(png)
  console.log('centered bbox:', JSON.stringify(bbox), 'tx=' + tx.toFixed(2), 'ty=' + ty.toFixed(2))
}

const out = join(iconsDir, 'icon-source.png')
writeFileSync(out, png.asPng())
console.log('written', out, png.width + 'x' + png.height)

// 512px preview for quick inspection
const small = new Resvg(svg(tx, ty), { fitTo: { mode: 'width', value: 512 } }).render()
writeFileSync(join(iconsDir, 'icon-preview.png'), small.asPng())
console.log('preview written (512px)')
