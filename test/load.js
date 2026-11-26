// Ładowanie modułów przeglądarkowych w Node (testy)
const fs = require('fs'), path = require('path'), vm = require('vm');
globalThis.self = globalThis;
const root = path.join(__dirname, '..', 'js');
for (const f of ['vendor/clipper.js', 'cadparse.js', 'geometry.js', 'nestcore.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}
const ClipperLib = ClipperFactory();
module.exports = { ClipperLib, NestCore: NestCoreFactory(ClipperLib), CadParse: globalThis.CadParse, Geometry: globalThis.Geometry };
require('vm').runInThisContext(require('fs').readFileSync(require('path').join(__dirname,'..','js','samples.js'),'utf8'));
module.exports.Samples = globalThis.Samples;
