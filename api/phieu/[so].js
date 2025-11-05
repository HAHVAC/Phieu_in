// api/phieu/[so].js
// Handler hoàn chỉnh: lấy tenant token, list phiếu, tìm record robust (normalize + suffix token),
// lấy linked record_ids từ "Danh sách mặt hàng" rồi batch_get chi tiết vật tư.
// Dùng fetch native (Node 18+ trên Vercel). Ensure env vars set on Vercel:
// LARK_APP_ID, LARK_APP_SECRET, PHIEU_APP_TOKEN, PHIEU_TABLE_ID, DATA_APP_TOKEN (opt), DATA_TABLE_ID (opt), LARK_DOMAIN (opt)

export default async function handler(req, res) {
  try {
    const { so, debug } = req.query;
    if (!so) return res.status(400).json({ error: "missing so param" });

    const LARK_DOMAIN = process.env.LARK_DOMAIN || "https://open.larksuite.com";
    const TENANT_TOKEN_URL = `${LARK_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`;

    // --- 1) tenant token (simple in-memory cache)
    if (!global.__tenantToken || (global.__tenantExpire || 0) < Date.now()) {
      const r = await fetch(TENANT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: process.env.LARK_APP_ID,
          app_secret: process.env.LARK_APP_SECRET
        })
      });
      const j = await r.json();
      if (!j.tenant_access_token) {
        return res.status(500).json({ error: "cannot fetch tenant token", raw: j });
      }
      global.__tenantToken = j.tenant_access_token;
      global.__tenantExpire = Date.now() + ((j.expire || 7200) * 1000) - 30000;
    }
    const token = global.__tenantToken;

    // --- 2) list records from PHIEU table
    const PHIEU_APP_TOKEN = process.env.PHIEU_APP_TOKEN;
    const PHIEU_TABLE_ID = process.env.PHIEU_TABLE_ID;
    if (!PHIEU_APP_TOKEN || !PHIEU_TABLE_ID) {
      return res.status(500).json({ error: "Missing PHIEU_APP_TOKEN or PHIEU_TABLE_ID env vars" });
    }
    const listUrl = `${LARK_DOMAIN}/open-apis/bitable/v1/apps/${PHIEU_APP_TOKEN}/tables/${PHIEU_TABLE_ID}/records`;
    const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }});
    if (!listResp.ok) {
      const t = await listResp.text();
      return res.status(listResp.status).json({ error: "listRecords failed", status: listResp.status, text: t });
    }
    const listJson = await listResp.json();
    const records = (listJson?.data?.items) || (listJson?.records) || [];

    // --- 3) helper: normalize to only alphanumeric (remove diacritics & non-alnum)
    function normalizeAlnum(s){
      if (s === undefined || s === null) return "";
      return String(s)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')   // remove diacritics
        .replace(/[^0-9a-zA-Z]/g, '')      // keep only letters+digits
        .toLowerCase();
    }

    // debug: log keys (visible in Vercel runtime logs)
    try { if (records && records.length) console.log("sample record keys:", Object.keys(records[0].fields || {})); } catch(e){}

    // --- 4) build suffix candidates from input 'so'
    const soNorm = normalizeAlnum(so);
    const soTokens = String(so).split(/[^0-9A-Za-z]+/).filter(Boolean).map(t=>t.toLowerCase());
    const suffixCandidates = [];
    if (soTokens.length >= 2) suffixCandidates.push( soTokens.slice(1).join('') );
    if (soTokens.length >= 3) suffixCandidates.push( soTokens.slice(-2).join('') );
    if (soTokens.length >= 1) suffixCandidates.push( soTokens.slice(-1).join('') );
    suffixCandidates.unshift(soNorm); // full normalized first
    if (debug) console.log("soNorm:", soNorm, "suffixCandidates:", suffixCandidates);

    // --- 5) FIND record using strategies: exact normalized -> normalized contains -> suffix matching
    function valueToHay(v){
      if (!v && v !== 0) return "";
      if (typeof v === 'string') return normalizeAlnum(v);
      if (typeof v === 'object' && v.text) return normalizeAlnum(v.text);
      if (Array.isArray(v)) return normalizeAlnum((v.join(' ')||''));
      return "";
    }

    let record = null;

    // exact normalized equality
    record = records.find(r => {
      const f = r.fields || r.field_values || {};
      for (const k of Object.keys(f||{})) {
        const hay = valueToHay(f[k]);
        if (!hay) continue;
        if (hay === soNorm) return true;
      }
      return false;
    });

    // normalized contains
    if (!record) {
      record = records.find(r => {
        const f = r.fields || r.field_values || {};
        for (const k of Object.keys(f||{})) {
          const hay = valueToHay(f[k]);
          if (!hay) continue;
          if (hay.includes(soNorm)) return true;
        }
        return false;
      });
    }

    // suffix candidates matching
    if (!record) {
      record = records.find(r => {
        const f = r.fields || r.field_values || {};
        for (const k of Object.keys(f||{})) {
          const hay = valueToHay(f[k]);
          if (!hay) continue;
          for (const sc of suffixCandidates) {
            if (!sc) continue;
            if (hay.includes(sc)) return true;
          }
        }
        return false;
      });
    }

    // if still not found -> return helpful sample candidates for debugging
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

    // --- 6) Build response meta from found record
    const f = record.fields || record.field_values || {};
    const resp = {
      so_phieu: f["Số phiếu"] || f["so_phieu"] || f["Số_phiếu"] || so,
      hang_muc: f["Hạng mục"] || f["hang_muc"] || "",
      nhom_ncc: f["Nhóm NCC"] || f["nhom_ncc"] || "",
      noi_dung: f["Nội dung"] || f["noi_dung"] || "",
      nha_cung: f["Nhà cung cấp"] || f["nha_cung"] || "",
      xuong: f["Xưởng"] || f["xuong"] || "",
      ngay_xuat: f["Ngày xuất"] || f["ngay_xuat"] || "",
      nguoi_lap: f["Người lập"] || f["nguoi_lap"] || "",
      items: []
    };

    // --- 7) Extract linked record ids from "Danh sách mặt hàng" style field
    let linkedIds = [];
    const potentialItemKey = Object.keys(f||{}).find(k => {
      const lk = String(k).toLowerCase();
      return (lk.includes('danh') && lk.includes('mặt')) || lk.includes('item') || lk.includes('hàng');
    }) || null;

    if (potentialItemKey) {
      const val = f[potentialItemKey];
      if (Array.isArray(val) && val.length>0) {
        const first = val[0];
        if (first && Array.isArray(first.record_ids)) linkedIds = first.record_ids.slice();
        else if (first && Array.isArray(first.record_ids) === false && first.record_ids) linkedIds.push(first.record_ids);
      } else if (val && typeof val === 'object') {
        if (Array.isArray(val.record_ids)) linkedIds = val.record_ids.slice();
      }
    }

    // --- 8) If linkedIds exist -> batch_get from DATA table
    if (linkedIds.length > 0) {
      const DATA_APP_TOKEN = process.env.DATA_APP_TOKEN || PHIEU_APP_TOKEN;
      const DATA_TABLE_ID = process.env.DATA_TABLE_ID || process.env.PHIEU_TABLE_ID;
      if (!DATA_APP_TOKEN || !DATA_TABLE_ID) {
        // can't batch_get without data table info; return linked ids for debug
        resp.items = linkedIds.map(id=>({ record_id: id }));
      } else {
        const batchUrl = `${LARK_DOMAIN}/open-apis/bitable/v1/apps/${DATA_APP_TOKEN}/tables/${DATA_TABLE_ID}/records/batch_get`;
        const rBatch = await fetch(batchUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ record_ids: linkedIds })
        });
        if (!rBatch.ok) {
          const txt = await rBatch.text();
          console.error("batch_get failed:", rBatch.status, txt);
          resp.items = linkedIds.map(id=>({ record_id: id }));
        } else {
          const jb = await rBatch.json();
          const rows = jb?.data?.items || jb?.records || [];
          for(const row of rows){
            const rf = row.fields || {};
            resp.items.push({
              name: rf["Tên VTHH"] || rf["Tên Vật tư"] || rf["Tên"] || rf["name"] || (rf.text_arr && rf.text_arr[0]) || '',
              unit: rf["Đơn vị tính"] || rf["Đơn vị"] || rf["unit"] || '',
              qty: rf["Số lượng"] || rf["qty"] || rf["Số lượng (thực)"] || '',
              note: rf["Ghi chú"] || rf["note"] || ''
            });
          }
        }
      }
    } else {
      // fallback: if potentialItemKey had text_arr or array of strings, map them
      if (potentialItemKey) {
        const val = f[potentialItemKey];
        if (Array.isArray(val) && val[0] && Array.isArray(val[0].text_arr)) {
          resp.items = val[0].text_arr.map(n => ({ name: n, unit:'', qty:'', note:'' }));
        } else if (Array.isArray(val) && val.every(x => typeof x === 'string')) {
          resp.items = val.map(n => ({ name: n, unit:'', qty:'', note:'' }));
        }
      }
    }

    // --- 9) Return
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json(resp);

  } catch (err) {
    console.error(err);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
