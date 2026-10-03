// Segmentation benchmark: node tests/eval-seg.js [-v]
const fs = require('fs');
const path = require('path');
const kuromoji = require('kuromoji');
const C = require('../extension/core.js');
const Seg = require('../extension/segment.js');
const dir = path.join(__dirname, 'fixtures');
const verbose = process.argv.includes('-v');

function run(tk) {
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.gold.json'))) {
    const name = f.replace('.gold.json', '');
    const gold = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const kind of ['manual-punct', 'manual', 'asr']) {
      const file = path.join(dir, `${name}.${kind}.json`);
      if (!fs.existsSync(file)) continue;
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const oldS = C.buildSentences(C.parseJson3(json), kind === 'asr');
      const newS = Seg.segment(Seg.unitsFromJson3(json), tk);
      const o = Seg.boundaryF1Text(oldS, gold), n = Seg.boundaryF1Text(newS, gold);
      rows.push({ case: `${name}.${kind}`, gold: gold.length, old_n: oldS.length, old_f1: o.f1.toFixed(2), new_n: newS.length, new_f1: n.f1.toFixed(2), new_p: n.precision.toFixed(2), new_r: n.recall.toFixed(2) });
      if (verbose) { console.log(`\n=== ${name}.${kind}`); newS.forEach((s) => console.log(s.start.toFixed(2).padStart(7), (s.end - s.start).toFixed(1).padStart(4) + 's', s.text, '   ', (s.why || []).join(' '))); }
    }
  }
  console.table(rows);
  return rows;
}
if (require.main === module) kuromoji.builder({ dicPath: path.join(__dirname, '../extension/dict') }).build((e, tk) => run(tk));
module.exports = { run };
