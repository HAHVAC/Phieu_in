// api/phieu/[so].js
import fetch from "node-fetch"; // nếu vercel hỗ trợ native fetch bạn có thể bỏ import

const LARK_DOMAIN = process.env.LARK_DOMAIN || "https://open.larksuite.com";
// endpoints
const TENANT_TOKEN_URL = `${LARK_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`;

/**
 * Helper: get tenant_access_token (cache in-memory until expired)
 */
let tenantTokenCache = { token: null, expiresAt: 0 };
async function getTenantToken() {
  const now = Date.now();
  if (tenantTokenCache.token && tenantTokenCache.expiresAt > now + 20000) {
    return tenantTokenCache.token;
  }
  const r = await fetch(TENANT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET
    })
  });
  if (!r.ok) throw new Error("Token fetch failed: " + r.status);
  const j = await r.json();
  if (!j.tenant_access_token) throw new Error("No tenant token: " + JSON.stringify(j));
  tenantTokenCache.token = j.tenant_access_token;
  // token usually valid ~7200s (2h). adjust accordingly if response gives expire
  tenantTokenCache.expiresAt = Date.now() + ( (j.expire || 7200) * 1000 );
  return tenantTokenCache.token;
}

/**
 * Helper: call Lark Base - list/search records in a table
 * Replace the URL pattern with the exact one from your console docs if different.
 */
async function listRecords(tenantToken, appToken, tableId, params = {}) {
  // Example endpoint pattern (use docs to confirm exact path)
  const url = `${LARK_DOMAIN}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;
  // If API expects query params, append them (paging/filters)
  // Many Lark endpoints use POST with body for filters – adjust per docs.
  const r = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      "Content-Type": "application/json"
    }
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`listRecords failed ${r.status}: ${text}`);
  }
  return r.json();
}

async function batchGetRecords(tenantToken, appToken, tableId, recordIds = []) {
  const url = `${LARK_DOMAIN}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_get`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      "Content-Type":"application/json"
    },
    body: JSON.stringify({ record_ids: recordIds })
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`batch_get failed ${r.status}: ${text}`);
  }
  return r.json();
}

/**
 * Main handler
 */
export default async function handler(req, res) {
  try {
    const { so } = req.query;
    if (!so) return res.status(400).json({ error: "missing so param" });

    const tenantToken = await getTenantToken();

    // You must supply APP_TOKEN and TABLE IDs in env variables (see instructions)
    const PHIEU_APP_TOKEN = process.env.PHIEU_APP_TOKEN; // app_token for Phiếu app
    const PHIEU_TABLE_ID = process.env.PHIEU_TABLE_ID;
    const DATA_APP_TOKEN = process.env.DATA_APP_TOKEN || PHIEU_APP_TOKEN; // might be same app
    const DATA_TABLE_ID = process.env.DATA_TABLE_ID;

    // --- 1) Find the phiếu record by so_phieu (you may need to use search API or list & filter)
    // For simplicity, call listRecords and filter in server if API does not support filter directly
    const phiRecordsResp = await listRecords(tenantToken, PHIEU_APP_TOKEN, PHIEU_TABLE_ID);
    // adapt per response structure
    const phiRecords = (phiRecordsResp?.data?.items) || (phiRecordsResp?.records) || [];
    // find by field value (adjust based on how Lark returns fields)
    const found = phiRecords.find(r => {
      // typical Lark record structure may include 'fields' or 'field_values'
      const fields = r.fields || r.field_values || r.values || {};
      const sp = fields.so_phieu || fields['Số phiếu'] || fields['so_phieu'] || null;
      if(!sp) return false;
      return String(sp).includes(so); // loosened match
    });

    if (!found) {
      return res.status(404).json({ error: "Phiếu not found", so });
    }

    // --- 2) Extract linked record ids (assume field name 'Vật tư liên kết' / 'linked_items')
    // Adjust to actual response structure & field id names
    const linkedField = found.fields?.linked_items || found.field_values?.linked_items || found.fields?.['Vật tư liên kết'];
    const linkedIds = Array.isArray(linkedField) ? linkedField : (linkedField?.value || linkedField) || [];
    // If linkedField contains objects, map ids accordingly
    const ids = linkedIds.map(x => (typeof x === 'object' ? (x.record_id || x.id) : x)).filter(Boolean);

    // --- 3) Batch get the data records
    const items = [];
    if (ids.length) {
      const batch = await batchGetRecords(tenantToken, DATA_APP_TOKEN, DATA_TABLE_ID, ids);
      const rows = batch?.data?.items || batch?.records || [];
      for (const r of rows) {
        const f = r.fields || r.field_values || {};
        items.push({
          name: f.ten_vthh || f['Tên VTHH'] || f.name || '',
          unit: f.don_vi_tinh || f['Đơn vị tính'] || f.unit || '',
          qty: f.so_luong || f['Tồn đầu kỳ'] || f.qty || '',
          note: f.ghi_chu || f.note || ''
        });
      }
    }

    // --- 4) Build final JSON
    const resp = {
      so_phieu: so,
      hang_muc: found.fields?.hang_muc || found.fields?.['Hạng mục'] || '',
      nhom_ncc: found.fields?.nhom_ncc || found.fields?.['Nhóm NCC'] || '',
      noi_dung: found.fields?.noi_dung || found.fields?.['Nội dung xuất'] || '',
      nha_cung: found.fields?.nha_cung || found.fields?.['Nhà cung cấp'] || '',
      xuong: found.fields?.xuong || found.fields?.['Xưởng'] || '',
      ngay_xuat: found.fields?.ngay_xuat || found.fields?.['Ngày xuất nhập'] || '',
      nguoi_lap: found.fields?.nguoi_lap || found.fields?.['Người lập'] || '',
      items
    };

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    res.status(200).json(resp);

  } catch (err) {
    console.error(err);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error: err.message });
  }
}
