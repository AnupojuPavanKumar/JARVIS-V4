const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

async function build() {
  console.log('🚀 Starting JARVIS minification build...');
  
  const distDir = path.join(__dirname, 'renderer', 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const modulesDir = path.join(__dirname, 'renderer', 'modules');
  const modulesDist = path.join(distDir, 'modules');
  if (!fs.existsSync(modulesDist)) {
    fs.mkdirSync(modulesDist, { recursive: true });
  }

  try {
    // ── JS: main renderer (no bundling — uses browser globals) ──
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'renderer', 'renderer.js')],
      bundle: false,
      minify: true,
      outfile: path.join(distDir, 'renderer.js'),
    });

    // ── JS: extracted modules ────────────────────────────────────
    if (fs.existsSync(modulesDir)) {
      const moduleFiles = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js'));
      for (const f of moduleFiles) {
        await esbuild.build({
          entryPoints: [path.join(modulesDir, f)],
          bundle: false,
          minify: true,
          outfile: path.join(modulesDist, f),
        });
      }
      console.log('   Modules minified:', moduleFiles.join(', '));
    }

    // ── CSS ──────────────────────────────────────────────────────
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'renderer', 'style.css')],
      outdir: distDir,
      bundle: true,
      minify: true,
      sourcemap: false,
      target: ['chrome120'],
      logLevel: 'info',
    });

    // ── Vendor: marked (copy minified UMD build) ─────────────────
    const markedSrc = path.join(__dirname, 'node_modules', 'marked', 'marked.min.js');
    if (fs.existsSync(markedSrc)) {
      fs.copyFileSync(markedSrc, path.join(distDir, 'marked.min.js'));
    } else {
      console.warn('   ⚠ marked.min.js not found — run: npm install marked');
    }

    // ── Vendor: dompurify (copy minified UMD build) ──────────────
    const purifySrc = path.join(__dirname, 'node_modules', 'dompurify', 'dist', 'purify.min.js');
    if (fs.existsSync(purifySrc)) {
      fs.copyFileSync(purifySrc, path.join(distDir, 'purify.min.js'));
    } else {
      console.warn('   ⚠ purify.min.js not found — run: npm install dompurify');
    }

    // ── Vendor: highlight.js (slim — only langs JARVIS needs) ────
    await require('./build_hljs_slim.js')(path.join(distDir, 'highlight.min.js'));

    // ── Vendor: highlight.js CSS theme ───────────────────────────
    const hljsCssSrc = path.join(__dirname, 'node_modules', 'highlight.js', 'styles', 'github-dark.min.css');
    if (fs.existsSync(hljsCssSrc)) {
      fs.copyFileSync(hljsCssSrc, path.join(distDir, 'github-dark.min.css'));
    } else {
      // fallback: try without .min
      const hljsCssFallback = path.join(__dirname, 'node_modules', 'highlight.js', 'styles', 'github-dark.css');
      if (fs.existsSync(hljsCssFallback)) {
        fs.copyFileSync(hljsCssFallback, path.join(distDir, 'github-dark.min.css'));
      } else {
        console.warn('   ⚠ highlight.js github-dark CSS not found');
      }
    }

    console.log('   Vendor libs bundled: marked.min.js, highlight.min.js, github-dark.min.css');
    console.log('✅ Build complete. Frontend files minified to renderer/dist/');
  } catch (err) {
    console.error('❌ Build failed:', err);
    process.exit(1);
  }
}

build();
