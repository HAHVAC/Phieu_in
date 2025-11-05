// api/phieu/[so].js
// Full handler với fallback auto-detect DATA_TABLE_ID từ field "Danh sách mặt hàng"
// Required envs: LARK_APP_ID, LARK_APP_SECRET, PHIEU_APP_TOKEN, PHIEU_TABLE_ID
// Optional envs: DATA_APP_TOKEN, DATA_TABLE_ID
// Default LARK_DOMAIN = https://open.larksuite.com

export default async function handler(req, res) {
  try {
    const { so, debug } = req.query;
    if (!so) return res.status(400).json({ error: "missing so param" });

    const LARK_DOMAIN = process.env.LARK_DOMAIN || "https://open.larksuite.com";
    const TENANT_TOKEN_URL = `${LARK_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`;

    // --- tenant token cache (in-memory)
    if (!global.__tenantToken || (global.__tenantExpire || 0) < Date.now()) {
      const r = await fetch(TENANT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET })
      });
      const j = await r.json();
      if (!j.tenant_access_token) {
        return res.status(500).json({ error: "cannot fetch tenant token", raw: j });
      }
      global.__tenantToken = j.tenant_access_token;
      global.__tenantExpire = Date.now() + ((j.expire || 7200) * 1000) - 30000;
    }
    const token = global.__tenantToken;

    // --- list records from PHIEU table
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

    // --- helpers
    function normalizeAlnum(s){
      if (s === undefined || s === null) return "";
      return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
    }
    function valueToHay(v){
      if (!v && v !== 0) return "";
      if (typeof v === 'string') return normalizeAlnum(v);
      if (typeof v === 'object' && v && v.text) return normalizeAlnum(v.text);
      if (Array.isArray(v)) return normalizeAlnum((v.join(' ')||''));
      return "";
    }

    // --- build suffix candidates from input 'so'
    const soNorm = normalizeAlnum(so);
    const soTokens = String(so).split(/[^0-9A-Za-z]+/).filter(Boolean).map(t=>t.toLowerCase());
    const suffixCandidates = [];
    if (soTokens.length >= 2) suffixCandidates.push( soTokens.slice(1).join('') );
    if (soTokens.length >= 3) suffixCandidates.push( soTokens.slice(-2).join('') );
    if (soTokens.length >= 1) suffixCandidates.push( soTokens.slice(-1).join('') );
    suffixCandidates.unshift(soNorm);

    if (debug) console.log("soNorm:", soNorm, "suffixCandidates:", suffixCandidates);

    // --- find record: strategies: exact -> contains -> suffix tokens
    let record = null;
    record = records.find(r => {
      const f = r.fields || r.field_values || {};
      for (const k of Object.keys(f||{})) {
        const hay = valueToHay(f[k]);
        if (!hay) continue;
        if (hay === soNorm) return true;
      }
      return false;
    });

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

    // not found -> return sample candidates for debug
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

    // --- response meta
    const f = record.fields || record.field_values || {};
    const resp = {
      so_phieu: f["Số phiếu"] || f["so_phieu"] || f["Số_phiếu"] || so,
      hang_muc: (f["Hạng mục"] && (Array.isArray(f["Hạng mục"]) ? (f["Hạng mục"][0]?.text || f["Hạng mục"][0]) : f["Hạng mục"])) || f["hang_muc"] || "",
      nhom_ncc: (f["Nhóm NCC"] && (Array.isArray(f["Nhóm NCC"]) ? (f["Nhóm NCC"][0]?.text || f["Nhóm NCC"][0]) : f["Nhóm NCC"])) || f["nhom_ncc"] || "",
      noi_dung: f["Nội dung"] || f["noi_dung"] || "",
      nha_cung: f["Nhà cung cấp"] || f["nha_cung"] || "",
      xuong: f["Xưởng"] || f["xuong"] || "",
      ngay_xuat: f["Ngày xuất"] || f["ngay_xuat"] || "",
      nguoi_lap: f["Người lập"] || f["nguoi_lap"] || "",
      items: []
    };

    // --- detect potential item field key
    let linkedIds = [];
    const potentialItemKey = Object.keys(f||{}).find(k => {
      const lk = String(k).toLowerCase();
      return (lk.includes('danh') && lk.includes('mặt')) || lk.includes('item') || lk.includes('hàng') || lk.includes('mặt hàng');
    }) || null;

    if (potentialItemKey) {
      const val = f[potentialItemKey];
      if (Array.isArray(val) && val.length>0) {
        const first = val[0];
        if (first && Array.isArray(first.record_ids)) linkedIds = first.record_ids.slice();
        else if (first && first.record_ids) linkedIds.push(first.record_ids);
      } else if (val && typeof val === 'object') {
        if (Array.isArray(val.record_ids)) linkedIds = val.record_ids.slice();
      }
    }

    if (debug) console.log("potentialItemKey:", potentialItemKey, "linkedIds:", linkedIds);

    // --- debug mode: return debug info and raw batch_get (if possible)
    if (debug === "1") {
      const dbg = { matched_record: record.record_id || record.id, potentialItemKey, linkedIds };
      if (linkedIds.length) {
        // attempt to auto-resolve data app/table and run batch_get
        let DATA_APP_TOKEN = process.env.DATA_APP_TOKEN || PHIEU_APP_TOKEN;
        let DATA_TABLE_ID  = process.env.DATA_TABLE_ID || process.env.PHIEU_TABLE_ID;

        // auto-detect table_id from field value when available
        try {
          if (!process.env.DATA_TABLE_ID && potentialItemKey) {
            const rawVal = f[potentialItemKey];
            const first = Array.isArray(rawVal) && rawVal.length ? rawVal[0] : rawVal;
            if (first && typeof first === 'object' && first.table_id) {
              DATA_TABLE_ID = first.table_id;
            }
            if (first && typeof first === 'object' && first.table && first.table.id) {
              DATA_TABLE_ID = first.table.id;
            }
            if (first && typeof first === 'object' && first.app_id) {
              DATA_APP_TOKEN = first.app_id;
            }
          }
        } catch(e){ dbg.table_detect_error = e.message; }

        if (DATA_APP_TOKEN && DATA_TABLE_ID) {
          try {
            const batchUrl = `${LARK_DOMAIN}/open-apis/bitable/v1/apps/${DATA_APP_TOKEN}/tables/${DATA_TABLE_ID}/records/batch_get`;
            const rBatch = await fetch(batchUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ record_ids: linkedIds })
            });
            const raw = await rBatch.text();
            try { dbg.batch_get = JSON.parse(raw); } catch(e){ dbg.batch_get_raw = raw; }
          } catch(e){
            dbg.batch_get_error = e.message;
          }
        } else {
          dbg.batch_get = "no_data_table_configured";
        }
      }
      return res.status(200).json({ debug: dbg });
    }

    // --- resolve DATA app/table with fallback to auto-detect table_id from field
    let DATA_APP_TOKEN = process.env.DATA_APP_TOKEN || PHIEU_APP_TOKEN;
    let DATA_TABLE_ID  = process.env.DATA_TABLE_ID || process.env.PHIEU_TABLE_ID;

    // auto-detect DATA_TABLE_ID from field if present
    try {
      if (!process.env.DATA_TABLE_ID && potentialItemKey) {
        const rawVal = f[potentialItemKey];
        const first = Array.isArray(rawVal) && rawVal.length ? rawVal[0] : rawVal;
        if (first && typeof first === 'object' && first.table_id) {
          DATA_TABLE_ID = first.table_id;
          console.log("Auto-detected DATA_TABLE_ID from field:", DATA_TABLE_ID);
        }
        if (first && typeof first === 'object' && first.table && first.table.id) {
          DATA_TABLE_ID = first.table.id;
          console.log("Auto-detected DATA_TABLE_ID from field.table:", DATA_TABLE_ID);
        }
        if (first && typeof first === 'object' && first.app_id) {
          DATA_APP_TOKEN = first.app_id;
          console.log("Auto-detected DATA_APP_TOKEN from field:", DATA_APP_TOKEN);
        }
      }
    } catch(e){
      console.warn("table_id extraction failed:", e && e.message);
    }

    // --- batch_get details if linkedIds available
    if (linkedIds.length > 0) {
      if (!DATA_APP_TOKEN || !DATA_TABLE_ID) {
        // cannot batch_get: return record_ids for debug
        resp.items = linkedIds.map(id => ({ record_id: id }));
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
          resp.items = linkedIds.map(id => ({ record_id: id }));
        } else {
          const jb = await rBatch.json();
          const rows = jb?.data?.items || jb?.records || [];

          // map rows by record_id for preserving input order
          const rowById = {};
          for (const row of rows) rowById[row.record_id || row.id] = row;

          // helper to get text from field shapes
          function txt(field) {
            if (!field && field !== 0) return '';
            if (Array.isArray(field) && field.length) {
              const first = field[0];
              if (first && typeof first === 'object' && 'text' in first) return String(first.text).trim();
              if (typeof field[0] === 'string') return String(field[0]).trim();
            }
            if (typeof field === 'object' && field.text) return String(field.text).trim();
            if (typeof field === 'string') return field.trim();
            return '';
          }

          // iterate linkedIds to preserve order
          for (const rid of linkedIds) {
            const row = rowById[rid];
            if (!row) {
              resp.items.push({ record_id: rid });
              continue;
            }
            const rf = row.fields || {};

            // basic fields
            const name = txt(rf["Tên VTHH"] || rf["Tên Vật tư"] || rf["Tên"] || rf["name"] ) || '';
            let unit = txt(rf["Đơn vị tính"] || rf["Đơn vị"] || rf["unit"]) || '';
            const note = txt(rf["Ghi chú"] || rf["note"] ) || '';

            // qty parse: try item_string first, then Số lượng field
            let qty = '';
            try {
              const itemStrObj = rf["item_string"];
              if (itemStrObj && typeof itemStrObj === 'object') {
                const val = itemStrObj.value || itemStrObj["value"];
                if (Array.isArray(val) && val.length) {
                  const first = String(val[0]);
                  const m = first.match(/text=([^;}]*)/);
                  if (m && m[1]) {
                    const parts = m[1].split('~').map(s=>s.trim());
                    if (parts.length >= 3) qty = parts[2];
                    else if (parts.length >= 2 && !unit) unit = parts[1];
                  }
                }
              }
            } catch(e){}

            if (!qty) {
              const qf = rf["Số lượng"] || rf["qty"] || rf["Số lượng (thực)"];
              if (qf) qty = txt(qf);
            }

            resp.items.push({
              record_id: row.record_id || row.id || null,
              name, unit, qty, note
            });
          }
        }
      }
    } else {
      // fallback: if potentialItemKey had text_arr or array-of-strings, map them
      if (potentialItemKey) {
        const val = f[potentialItemKey];
        if (Array.isArray(val) && val[0] && Array.isArray(val[0].text_arr)) {
          resp.items = val[0].text_arr.map(n => ({ name: n, unit:'', qty:'', note:'' }));
        } else if (Array.isArray(val) && val.every(x => typeof x === 'string')) {
          resp.items = val.map(n => ({ name: n, unit:'', qty:'', note:'' }));
        }
      }
    }

    // --- return response
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json(resp);

  } catch (err) {
    console.error(err);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
