// api/phieu/[so].js
// Handler lấy tenant token tự động, tìm Phiếu theo so, batch_get items từ bảng Data,
// trả về object { so_phieu, hang_muc, nhom_ncc, noi_dung, nha_cung, xuong, ngay_xuat, nguoi_lap, items: [...] }
// Env required: LARK_APP_ID, LARK_APP_SECRET, PHIEU_APP_TOKEN, PHIEU_TABLE_ID
// Optional: DATA_APP_TOKEN, DATA_TABLE_ID
const LARK_DOMAIN = process.env.LARK_DOMAIN || "https://open.larksuite.com";

async function getTenantToken() {
  // cache in global to avoid frequent requests (valid ~7200s)
  if (global.__larkTenant && global.__larkTenant.expiresAt > Date.now()) {
    return global.__larkTenant.token;
  }
  const app_id = process.env.LARK_APP_ID;
  const app_secret = process.env.LARK_APP_SECRET;
  if (!app_id || !app_secret) throw new Error("Missing LARK_APP_ID or LARK_APP_SECRET env vars");
  const resp = await fetch(`${LARK_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id, app_secret }),
  });
  const j = await resp.json();
  if (!j || !j.tenant_access_token) throw new Error("Cannot obtain tenant token: " + JSON.stringify(j));
  const token = j.tenant_access_token;
  const ttl = (j.expire || 7200) * 1000;
  global.__larkTenant = { token, expiresAt: Date.now() + ttl - 30000 };
  return token;
}

function extractText(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v) && v.length) {
    const first = v[0];
    if (first && typeof first === "object" && "text" in first) return String(first.text).trim();
    if (typeof first === "string") return first.trim();
  }
  if (typeof v === "object") {
    if ("text" in v) return String(v.text).trim();
    if ("value" in v && Array.isArray(v.value) && v.value.length) {
      const vv = v.value[0];
      if (vv && typeof vv === "object" && "text" in vv) return String(vv.text).trim();
      return String(v.value[0]);
    }
  }
  return String(v || "");
}

function normalize(s = "") {
  return String(s || "").toLowerCase().replace(/\s+/g, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export default async function handler(req, res) {
  try {
    const soParam = (req.query.so || req.query.s || "").toString().trim();
    if (!soParam) return res.status(400).json({ error: "missing so param" });
    const debug = req.query.debug !== undefined;

    const tenantToken = await getTenantToken();

    // required PHIEU app/table
    const PHIEU_APP_TOKEN = process.env.PHIEU_APP_TOKEN;
    const PHIEU_TABLE_ID = process.env.PHIEU_TABLE_ID;
    if (!PHIEU_APP_TOKEN || !PHIEU_TABLE_ID) {
      return res.status(500).json({ error: "Missing PHIEU_APP_TOKEN or PHIEU_TABLE_ID env" });
    }

    // 1) list records from PHIEU table (page_size large enough for typical use)
    const listUrl = `${LARK_DOMAIN}/open-apis/bitable/v1/apps/${PHIEU_APP_TOKEN}/tables/${PHIEU_TABLE_ID}/records?page_size=200`;
    const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${tenantToken}`, "Content-Type": "application/json" }});
    if (!listResp.ok) {
      const txt = await listResp.text();
      return res.status(listResp.status).json({ error: "listRecords failed", status: listResp.status, text: txt });
    }
    const listJson = await listResp.json();
    const allRecords = listJson?.data?.items || listJson?.records || [];

    // 2) find matching record by Số phiếu (try exact then normalized contains)
    const soNorm = normalize(soParam);
    let matched = null;
    const tryMatch = (r) => {
      const f = r.fields || {};
      for (const k of Object.keys(f||{})) {
        const v = extractText(f[k]);
        if (!v) continue;
        if (normalize(v) === soNorm) return true;
        if (normalize(v).includes(soNorm)) return true;
      }
      return false;
    };
    matched = allRecords.find(tryMatch);
    if (!matched) {
      // also try by common keys directly
      matched = allRecords.find(r => {
        const f = r.fields || {};
        const candidates = [f["Số phiếu"], f["so_phieu"], f["Số_phiếu"], f["Số phiếu "], f["Số phiếu"]];
        for (const c of candidates) {
          if (c && normalize(extractText(c)) === soNorm) return true;
        }
        return false;
      });
    }
    if (!matched) {
      return res.status(404).json({ error: "Phiếu not found", so: soParam, total_records: allRecords.length });
    }

    const f = matched.fields || {};
    const result = {
      so_phieu: extractText(f["Số phiếu"] || f["so_phieu"] || soParam),
      hang_muc: extractText(f["Hạng mục"] || f["Hang muc"] || ""),
      nhom_ncc: extractText(f["Nhóm NCC"] || f["Nhóm nhà cung cấp"] || ""),
      noi_dung: extractText(f["Nội dung"] || f["Nội dung xuất"] || ""),
      nha_cung: extractText(f["Nhà cung cấp"] || f["nha_cung"] || ""),
      xuong: extractText(f["Xưởng"] || f["xuong"] || ""),
      ngay_xuat: extractText(f["Ngày xuất"] || f["ngay_xuat"] || ""),
      nguoi_lap: extractText(f["Người lập"] || f["nguoi_lap"] || ""),
      items: []
    };

    // 3) detect linked item record ids from field "Danh sách mặt hàng" (several possible shapes)
    let linkedIds = [];
    const possibleKeys = Object.keys(f || {}).filter(k => k.toLowerCase().includes('danh') && k.toLowerCase().includes('mặt') || k.toLowerCase().includes('mat hang') || k.toLowerCase().includes('item'));
    const potentialKey = possibleKeys.length ? possibleKeys[0] : null;
    if (potentialKey) {
      const val = f[potentialKey];
      // shape: { record_ids: [...] } or [{ record_ids: [...] }] or array of strings
      if (Array.isArray(val) && val.length && val[0] && typeof val[0] === 'object' && Array.isArray(val[0].record_ids)) {
        linkedIds = val[0].record_ids.slice();
      } else if (val && typeof val === 'object' && Array.isArray(val.record_ids)) {
        linkedIds = val.record_ids.slice();
      } else if (Array.isArray(val) && val.every(x => typeof x === 'string')) {
        // maybe simple text names (no record ids) - do nothing
        linkedIds = [];
      }
    }

    // 4) resolve DATA app/table (env override or fallback to PHIEU_APP_TOKEN)
    let DATA_APP_TOKEN = process.env.DATA_APP_TOKEN || PHIEU_APP_TOKEN;
    let DATA_TABLE_ID = process.env.DATA_TABLE_ID || null;
    // attempt to auto-extract table_id/app_id from field value when present (fallback)
    try {
      if (!process.env.DATA_TABLE_ID && potentialKey) {
        const rawVal = f[potentialKey];
        const first = Array.isArray(rawVal) && rawVal.length ? rawVal[0] : rawVal;
        if (first && typeof first === 'object' && first.table_id) DATA_TABLE_ID = first.table_id;
        if (first && typeof first === 'object' && first.table && first.table.id) DATA_TABLE_ID = first.table.id;
        if (first && typeof first === 'object' && first.app_id) DATA_APP_TOKEN = first.app_id;
      }
    } catch (e) {
      // ignore
    }
    // fallback: if still null, assume data in same app as PHIEU
    if (!DATA_TABLE_ID) DATA_TABLE_ID = process.env.DATA_TABLE_ID || process.env.PHIEU_TABLE_ID || null;

    // 5) if linkedIds found, call batch_get to retrieve rows
    if (linkedIds.length > 0) {
      if (!DATA_APP_TOKEN || !DATA_TABLE_ID) {
        // cannot batch_get - return ids only
        result.items = linkedIds.map(id => ({ record_id: id }));
      } else {
        const batchUrl = `${LARK_DOMAIN}/open-apis/bitable/v1/apps/${DATA_APP_TOKEN}/tables/${DATA_TABLE_ID}/records/batch_get`;
        try {
          const rb = await fetch(batchUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${tenantToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ record_ids: linkedIds })
          });
          if (!rb.ok) {
            const txt = await rb.text();
            // fallback to ids
            console.error("batch_get failed:", rb.status, txt);
            result.items = linkedIds.map(id => ({ record_id: id }));
            if (debug) result._batch_get_error = { status: rb.status, text: txt };
          } else {
            const jb = await rb.json();
            const rows = jb?.data?.records || jb?.records || [];
            // map rows by id for ordering
            const byId = {};
            for (const r of rows) byId[r.record_id || r.id] = r;

            // helper parse
            for (const rid of linkedIds) {
              const row = byId[rid];
              if (!row) {
                result.items.push({ record_id: rid });
                continue;
              }
              const rf = row.fields || {};
              const name = extractText(rf["Tên VTHH"] || rf["Tên Vật tư"] || rf["Tên"] || rf["Tên hàng"] || rf["name"]);
              const unit = extractText(rf["Đơn vị tính"] || rf["Đơn vị"] || rf["unit"]);
              const note = extractText(rf["Ghi chú"] || rf["note"]);
              let qty = "";
              // try item_string pattern
              const itemStr = rf["item_string"] || rf["item_str"] || rf["items"];
              if (itemStr && typeof itemStr === 'object') {
                const val = itemStr.value || itemStr["value"];
                if (Array.isArray(val) && val.length) {
                  const t0 = extractText(val[0]);
                  const parts = t0.split("~").map(s => s.trim());
                  if (parts.length >= 3) qty = parts[2];
                  else if (parts.length >= 2 && !unit) qty = parts[1];
                }
              }
              // fallback qty field
              if (!qty) qty = extractText(rf["Số lượng"] || rf["qty"] || rf["Quantity"]);
              result.items.push({ record_id: rid, name, unit, qty, note });
            }
            if (debug) result._batch_get_raw = jb;
          }
        } catch (e) {
          console.error("batch_get exception:", e && e.message);
          result.items = linkedIds.map(id => ({ record_id: id }));
          if (debug) result._batch_get_exception = String(e && e.message);
        }
      }
    } else {
      // no linkedIds: try to parse textual item list if present (text_arr, simple strings)
      if (potentialKey) {
        const val = f[potentialKey];
        if (Array.isArray(val) && val.length && Array.isArray(val[0]?.text_arr)) {
          result.items = val[0].text_arr.map(t => ({ name: t, unit: "", qty: "", note: "" }));
        } else if (Array.isArray(val) && val.every(x => typeof x === 'string')) {
          result.items = val.map(t => ({ name: t, unit: "", qty: "", note: "" }));
        }
      }
    }

    // respond
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json(result);

  } catch (err) {
    console.error("handler error:", err && err.message);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: err && err.message });
  }
}
