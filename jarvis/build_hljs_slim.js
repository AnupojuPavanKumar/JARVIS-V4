const fs = require('fs');
const path = require('path');

module.exports = async function buildHljs(outPath) {
  if (fs.existsSync(outPath)) {
    console.log(`   Slim highlight.js exists: ${Math.round(fs.statSync(outPath).size / 1024)} KB`);
    return;
  }
  
  console.warn('   ⚠ highlight.min.js missing and slim builder was removed. Creating dummy file.');
  fs.writeFileSync(outPath, '// highlight.min.js dummy fallback\n');
};
