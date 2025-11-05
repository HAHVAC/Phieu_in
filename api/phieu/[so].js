// api/phieu/[so].js
// Không cần node-fetch (Node 18+ has fetch)
export default async function handler(req, res) {
  try {
    const { so, debug } = req.query;
    if (!so) return res.status(400).json({ error: "missing so param" });

    const LARK_DOMAIN = process.env.LARK_DOMAIN || "https://open.larksuite.com";
    const TENANT_TOKEN_URL = `${LARK_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`;

    // 1) tenant token (cache naive)
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
      if (!j.tenant_access_token) return res.status(500).json({ error: "no tenant token", raw: j });
      global.__tenantToken = j.tenant_access_token;
      global.__tenantExpire = Date.now() + ((j.expire || 7200) * 1000) - 30000;
    }
    const token = global.__tenantToken;

    // 2) list records from PHIEU table (like bạn đã làm)
    const PHIEU_APP_TOKEN = process.env.PHIEU_APP_TOKEN;
    const PHIEU_TABLE_ID = process.env.PHIEU_TABLE_ID;
    const listUrl = `${LARK_DOMAIN}/open-apis/bitable/v1/apps/${PHIEU_APP_TOKEN}/tables/${PHIEU_TABLE_ID}/records`;
    const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }});
    if (!listResp.ok) {
      const t = await listResp.text();
      return res.status(listResp.status).json({ error: "listRecords failed", status: listResp.status, text: t });
    }
    const listJson = await listResp.json();
    const records = (listJson?.data?.items) || (listJson?.records) || [];

    // helper: normalize & remove diacritics for robust match
    function stripDiacritics(s){
      if(!s && s !== 0) return "";
      return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    }
    function recordMatchesSo(rec, soTarget){
      const f = rec.fields || rec.field_values || {};
      // try common keys first (with diacritics and english)
      const keys = Object.keys(f||{});
      for(const k of keys){
        try {
          const v = f[k];
          if(typeof v === 'string' && stripDiacritics(v) === stripDiacritics(soTarget)) return true;
          if(typeof v === 'object' && v && v.text && stripDiacritics(v.text) === stripDiacritics(soTarget)) return true;
          // string inside array
          if(Array.isArray(v) && v.some(x=> typeof x === 'string' && stripDiacritics(x) === stripDiacritics(soTarget))) return true;
        } catch {}
      }
      return false;
    }

    // find record
    let record = records.find(r => recordMatchesSo(r, so));
    // fallback to contains
    if(!record){
      record = records.find(r => {
        const f = r.fields || r.field_values || {};
        return Object.values(f||{}).some(v => {
          if(!v) return false;
          if(typeof v === 'string') return stripDiacritics(v).includes(stripDiacritics(so));
          if(typeof v === 'object' && v.text) return stripDiacritics(v.text).includes(stripDiacritics(so));
          return false;
        });
      });
    }

    if(!record) return res.status(404).json({ error: "Phiếu not found", so, total_records: records.length });

    // build response meta
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

    // 3) Extract record_ids from field "Danh sách mặt hàng"
    // Based on your output: fields["Danh sách mặt hàng"] is an array; first element has record_ids array.
    let linkedIds = [];
    const candidateKeys = Object.keys(f||{}).filter(k => k && k.toString().toLowerCase().includes('danh') && k.toString().toLowerCase().includes('mặt'));
    const itemsKey = candidateKeys.length ? candidateKeys[0] : (Object.keys(f||{}).find(k=> ['Danh sách mặt hàng','items','Items'].includes(k)) || null);

    if(itemsKey){
      const val = f[itemsKey];
      // if array and first element has record_ids
      if(Array.isArray(val) && val.length>0){
        const first = val[0];
        if(first && Array.isArray(first.record_ids)) linkedIds = first.record_ids.slice();
        // sometimes it's record_ids nested deeper
        if(first && Array.isArray(first.record_ids) === false && first.record_ids) {
          // if record_ids is present but not array
          if(typeof first.record_ids === 'string') linkedIds.push(first.record_ids);
        }
      } else if(val && typeof val === 'object') {
        if(Array.isArray(val.record_ids)) linkedIds = val.record_ids.slice();
      }
    }

    // 4) If have linkedIds -> batch_get records from DATA table
    if(linkedIds.length > 0){
      const DATA_APP_TOKEN = process.env.DATA_APP_TOKEN || PHIEU_APP_TOKEN;
      const DATA_TABLE_ID = process.env.DATA_TABLE_ID || process.env.PHIEU_TABLE_ID;
      const batchUrl = `${LARK_DOMAIN}/open-apis/bitable/v1/apps/${DATA_APP_TOKEN}/tables/${DATA_TABLE_ID}/records/batch_get`;
      const rBatch = await fetch(batchUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ record_ids: linkedIds })
      });
      if(!rBatch.ok){
        const txt = await rBatch.text();
        if(debug) console.log('batch_get failed', txt);
        // fallback: include linkedIds raw
        resp.items = linkedIds.map(id=>({ record_id: id }));
      } else {
        const jb = await rBatch.json();
        const rows = jb?.data?.items || jb?.records || [];
        for(const row of rows){
          const rf = row.fields || {};
          resp.items.push({
            name: rf["Tên VTHH"] || rf["Tên Vật tư"] || rf["Tên VTHH"] || rf["Tên"] || rf["name"] || (rf.text_arr && rf.text_arr[0]) || '',
            unit: rf["Đơn vị tính"] || rf["Đơn vị"] || rf["unit"] || '',
            qty: rf["Số lượng"] || rf["qty"] || rf["Số lượng (thực)"] || '',
            note: rf["Ghi chú"] || rf["note"] || ''
          });
        }
      }
    } else {
      // fallback: check if itemsKey contains text_arr (your response had text_arr with repeated "Báo cháy")
      if(itemsKey){
        const val = f[itemsKey];
        if(Array.isArray(val) && val[0] && Array.isArray(val[0].text_arr)) {
          resp.items = val[0].text_arr.map(n => ({ name: n, unit:'', qty:'', note:'' }));
        } else if(Array.isArray(val) && val.every(x => typeof x === 'string')) {
          resp.items = val.map(n => ({ name: n, unit:'', qty:'', note:'' }));
        } else {
          resp.items = [];
        }
      }
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json(resp);

  } catch (err) {
    console.error(err);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
