// --- robust find: normalize-to-alphanumeric and contains matching
function normalizeAlnum(s){
  if(s === undefined || s === null) return "";
  return String(s)
    .normalize('NFD')                   // decompose accents
    .replace(/[\u0300-\u036f]/g, '')     // remove diacritics
    .replace(/[^0-9a-zA-Z]/g, '')        // keep only alphanum
    .toLowerCase();
}

// debug: log first record keys to Vercel logs (helps if still failing)
try {
  if (records && records.length > 0) {
    console.log("Sample record keys:", Object.keys(records[0].fields || {}));
  }
} catch(e){ console.log("log error", e); }

const soNorm = normalizeAlnum(so);

// 1) exact normalized equality
let record = records.find(r => {
  const f = r.fields || r.field_values || {};
  for(const k of Object.keys(f||{})){
    const v = f[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && normalizeAlnum(v) === soNorm) return true;
    if (typeof v === 'object' && v && v.text && normalizeAlnum(v.text) === soNorm) return true;
    if (Array.isArray(v) && v.some(x=> typeof x === 'string' && normalizeAlnum(x) === soNorm)) return true;
  }
  return false;
});

// 2) fallback: normalized contains
if (!record) {
  record = records.find(r => {
    const f = r.fields || r.field_values || {};
    for(const k of Object.keys(f||{})){
      const v = f[k];
      if (!v) continue;
      if (typeof v === 'string' && normalizeAlnum(v).includes(soNorm)) return true;
      if (typeof v === 'object' && v.text && normalizeAlnum(v.text).includes(soNorm)) return true;
      if (Array.isArray(v) && v.some(x => typeof x === 'string' && normalizeAlnum(x).includes(soNorm))) return true;
    }
    return false;
  });
}

// 3) nếu vẫn không tìm được -> trả sample_candidates để debug
if (!record) {
  const candidates = records.slice(0,10).map(r=>{
    const f = r.fields || r.field_values || {};
    const soCandidates = [];
    for(const k of Object.keys(f||{})){
      const v = f[k];
      if(!v) continue;
      if (typeof v === 'string') soCandidates.push(v);
      else if (typeof v === 'object' && v.text) soCandidates.push(v.text);
      else if (Array.isArray(v)) soCandidates.push(...v.filter(x=> typeof x === 'string'));
    }
    return { record_id: r.record_id || r.id, soCandidates: soCandidates.slice(0,3) };
  });
  return res.status(404).json({ error: "Phiếu not found (normalized search)", so, total_records: records.length, sample_candidates: candidates });
}
