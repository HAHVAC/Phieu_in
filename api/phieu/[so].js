export default function handler(req, res) {
  const { so } = req.query;

  const db = {
    "DXVT-HTP-A1-001": {
      so_phieu: "DXVT-HTP-A1-001",
      hang_muc: "Xuất",
      nhom_ncc: "NCC314",
      noi_dung: "xuất thi công",
      nha_cung: "NCC314",
      xuong: "A1",
      ngay_xuat: "2025-02-01",
      nguoi_lap: "TL0068",
      items: [
        { name: "Tủ trung tâm báo cháy N6000", unit: "Tủ", qty: 4, note: "" },
        { name: "Đầu báo khói 882 + B801RA", unit: "Bộ", qty: 3, note: "" },
      ],
    },
  };

  const record = db[so];
  if (!record) {
    res.status(404).json({ error: "Phiếu không tồn tại", so });
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  res.status(200).json(record);
}
