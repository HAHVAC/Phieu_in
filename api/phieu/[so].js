// api/phieu/[so].js
export default async function handler(req, res) {
  const so = decodeURIComponent(req.query.so || '').trim();
  const debug = req.query.debug !== undefined;

  const LARK_DOMAIN = process.env.LARK_DOMAIN || "https://open.larksuite.com";
  const TENANT_TOKEN = process.env.TENANT_ACCESS_TOKEN;
  const APP_TOKEN = process.env.PHIEU_APP_TOKEN;
  const TABLE_ID = process.env.PHIEU_TABLE_ID;

  const DATA_APP_TOKEN = process.env.DATA_APP_TOKEN || APP_TOKEN;
  const DATA_TABLE_ID = process.env.DATA_TABLE_ID;

  async function larkFetch(url, options = {}) {
    const res = await fetch(`${LARK_DOMAIN}${url}`, {
      headers: {
        Authorization: `Bearer ${TENANT_TOKEN}`,
        "Content-Type": "application/json",
      },
      ...options,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Lark API failed ${res.status}: ${text}`);
    }
    return res.json();
  }

  try {
    // --- 1. Lấy tất cả records trong bảng Phiếu
    const list = await larkFetch(`/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?page_size=200`);
    const records = list.data.items || [];

    // --- 2. Tìm record khớp số phiếu
    const match = records.find((r) => {
      const f = r.fields || {};
      return (
        (f["Số phiếu"] && f["Số phiếu"].toString().trim() === so) ||
        (f["So phieu"] && f["So phieu"].toString().trim() === so)
      );
    });

    if (!match) {
      return res.status(404).json({ error: "Phiếu not found", so, total_records: records.length });
    }

    const fields = match.fields;
    const result = {
      so_phieu: fields["Số phiếu"] || fields["So phieu"] || "",
      hang_muc: fields["Hạng mục"] || "",
      nhom_ncc: fields["Nhóm NCC"] || "",
      noi_dung: fields["Nội dung xuất"] || "",
      nha_cung: fields["Nhà cung cấp"] || "",
      xuong: fields["Xưởng"] || "",
      ngay_xuat: fields["Ngày xuất"] || "",
      nguoi_lap: fields["Người lập"] || "",
      items: [],
    };

    // --- 3. Xác định danh sách item record_ids
    let linkedIds = [];
    if (fields["Danh sách mặt hàng"]?.record_ids?.length) {
      linkedIds = fields["Danh sách mặt hàng"].record_ids;
    }

    // --- 4. Nếu có items thì gọi batch_get từ bảng Data
    if (linkedIds.length && DATA_APP_TOKEN && DATA_TABLE_ID) {
      try {
        const batchRes = await larkFetch(
          `/open-apis/bitable/v1/apps/${DATA_APP_TOKEN}/tables/${DATA_TABLE_ID}/records/batch_get`,
          {
            method: "POST",
            body: JSON.stringify({ record_ids: linkedIds }),
          }
        );

        const items = (batchRes.data.records || []).map((r) => {
          const f = r.fields || {};
          const name = extractText(f["Tên VTHH"] || f["Tên vật tư"] || "");
          const unit = extractText(f["Đơn vị tính"] || f["Đơn vị"] || "");
          const note = extractText(f["Ghi chú"] || "");
          let qty = "";
          const itemStr = f["item_string"];
          if (itemStr?.value?.length) {
            const t = itemStr.value[0].text || "";
            const parts = t.split("~").map((x) => x.trim());
            qty = parts[2] || "";
          }
          return { record_id: r.record_id, name, unit, qty, note };
        });

        result.items = items;
      } catch (err) {
        console.error("batch_get failed:", err);
      }
    }

    // --- 5. Gửi về client
    if (debug) {
      return res.status(200).json({
        ...result,
        debug: { soNorm: so, linkedIds, DATA_APP_TOKEN, DATA_TABLE_ID },
      });
    } else {
      return res.status(200).json(result);
    }
  } catch (error) {
    console.error("Handler error:", error);
    res.status(500).json({ error: error.message });
  }

  function extractText(v) {
    if (!v) return "";
    if (typeof v === "string") return v.trim();
    if (Array.isArray(v) && v.length) {
      const t = v[0];
      if (typeof t === "string") return t.trim();
      if (t?.text) return t.text.trim();
    }
    if (v.text) return v.text.trim();
    return "";
  }
}
