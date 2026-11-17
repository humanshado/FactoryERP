#!/usr/bin/env python3
"""Import a Manufacturing ERP Excel workbook (.xlsm / .xlsx) into a FactoryERP seed file.

Usage:
    python3 tools/import_xlsm.py path/to/Manufacturing_ERP.xlsm [server/seed/sample.json]

Reads the "... DB" sheets (row 3 = headers, data from row 4) and the lists and
settings on the Admin sheet, and writes one JSON file that the server loads into
an empty database (npm run reset-db reloads it).

Needs openpyxl (pip install openpyxl).
"""
import datetime as dt
import json
import sys

import openpyxl

# sheet -> (table, [(header in row 3, field, kind)])
TABLES = {
    "Items DB": ("items", [
        ("Item ID", "id", "int"), ("Item Name", "name", "text"), ("Item Code", "code", "text"),
        ("Description", "description", "text"), ("Item Type", "type", "text"), ("Category", "category", "text"),
        ("Unit", "unit", "text"), ("Unit Cost", "unitCost", "num"), ("Price", "price", "num"),
        ("Opening Stock", "openingStock", "num"), ("Reorder Point", "reorderPoint", "num"),
        ("Supplier", "supplier", "text"), ("Expiry Date", "expiryDate", "date"), ("Notes", "notes", "text")]),
    "BOM Lines DB": ("bomLines", [
        ("BOM Line ID", "id", "int"), ("Item ID", "itemId", "int"), ("Material", "material", "text"),
        ("Qty Per Unit", "qtyPerUnit", "num")]),
    "Routing Steps DB": ("routingSteps", [
        ("Routing Step ID", "id", "int"), ("Item ID", "itemId", "int"), ("Work Center", "workCenter", "text"),
        ("Hours Per Unit", "hoursPerUnit", "num")]),
    "Customers DB": ("customers", [
        ("Customer ID", "id", "int"), ("Customer Name", "name", "text"), ("Contact", "contact", "text"),
        ("Phone", "phone", "text"), ("Email", "email", "text"), ("Street", "street", "text"), ("City", "city", "text"),
        ("State", "state", "text"), ("Zip", "zip", "text"), ("Notes", "notes", "text")]),
    "Suppliers DB": ("suppliers", [
        ("Supplier ID", "id", "int"), ("Supplier Name", "name", "text"), ("Contact", "contact", "text"),
        ("Phone", "phone", "text"), ("Email", "email", "text"), ("Lead Days", "leadDays", "num"), ("Notes", "notes", "text")]),
    "Orders DB": ("orders", [
        ("Order ID", "id", "int"), ("Order #", "orderNo", "text"), ("Type", "type", "text"),
        ("Customer/Supplier", "party", "text"), ("Order Date", "orderDate", "date"), ("Due Date", "dueDate", "date"),
        ("Status", "status", "text"), ("From", "fromNo", "text"), ("Qty", "qty", "num"), ("Priority", "priority", "text"),
        ("Closed Date", "closedDate", "date"), ("Paid Date", "paidDate", "date"), ("Notes", "notes", "text"),
        ("Tax Rate", "taxRate", "num"), ("Tax Name", "taxName", "text"), ("Use Tax", "useTax", "text")]),
    "Order Lines DB": ("orderLines", [
        ("Order Line ID", "id", "int"), ("Order ID", "orderId", "int"), ("Item", "item", "text"),
        ("Description", "description", "text"), ("Qty", "qty", "num"), ("Price", "price", "num")]),
    "Operations DB": ("operations", [
        ("Operation ID", "id", "int"), ("Order ID", "orderId", "int"), ("Work Center", "workCenter", "text"),
        ("Op Start", "opStart", "date"), ("Days", "days", "num"), ("Hours", "hours", "num"), ("Done", "done", "bool")]),
    "Money Entries DB": ("moneyEntries", [
        ("Money Entry ID", "id", "int"), ("Entry Date", "entryDate", "date"), ("Direction", "direction", "text"),
        ("Category", "category", "text"), ("Party", "party", "text"), ("Reference", "reference", "text"),
        ("Amount", "amount", "num"), ("Method", "method", "text"), ("Notes", "notes", "text")]),
    "Employees DB": ("employees", [
        ("Employee ID", "id", "int"), ("Employee Name", "name", "text"), ("Role", "role", "text"),
        ("Work Center", "workCenter", "text"), ("Hourly Rate", "hourlyRate", "num"), ("Start Date", "startDate", "date"),
        ("Phone", "phone", "text"), ("Notes", "notes", "text")]),
    "Time Entries DB": ("timeEntries", [
        ("Time Entry ID", "id", "int"), ("Employee ID", "employeeId", "int"), ("Work Date", "workDate", "date"),
        ("WO No", "woNo", "text"), ("Hours", "hours", "num"), ("Notes", "notes", "text")]),
}

INCOME = {"customer payment", "other income"}


def conv(v, kind):
    if v is None or (isinstance(v, str) and v.strip() == ""):
        return None
    if isinstance(v, str) and v.startswith("="):
        return None
    if kind == "date":
        if isinstance(v, (dt.datetime, dt.date)):
            return v.strftime("%Y-%m-%d")
        return None
    if kind == "int":
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return None
    if kind == "num":
        try:
            return float(v) if float(v) != int(float(v)) else int(float(v))
        except (TypeError, ValueError):
            return None
    if kind == "bool":
        return str(v).strip().lower() in ("yes", "true", "1")
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def read_table(ws, cols):
    headers = {str(c.value).strip(): i for i, c in enumerate(ws[3]) if c.value is not None}
    out = []
    for row in ws.iter_rows(min_row=4, values_only=True):
        if row[0] is None or row[0] == "":
            continue
        rec = {}
        for header, field, kind in cols:
            i = headers.get(header)
            rec[field] = conv(row[i], kind) if i is not None and i < len(row) else None
        if rec.get("id") is None:
            continue
        out.append(rec)
    return out


def column(ws, col, first, last):
    vals = []
    for r in range(first, last + 1):
        v = ws[f"{col}{r}"].value
        if v is None or str(v).strip() == "":
            continue
        vals.append(str(v).strip())
    return vals


def main():
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else "server/seed/sample.json"
    wb = openpyxl.load_workbook(src, data_only=True)
    data = {}
    for sheet, (table, cols) in TABLES.items():
        data[table] = read_table(wb[sheet], cols) if sheet in wb.sheetnames else []

    ad = wb["Admin"]
    named = {n: wb.defined_names[n].attr_text for n in wb.defined_names.keys()}

    def nv(name, default=None):
        ref = named.get(name, "")
        if "!" not in ref:
            return default
        sheet, addr = ref.split("!")
        v = wb[sheet.strip("'")][addr.replace("$", "")].value
        return default if v is None else v

    wcs = []
    for r in range(6, 16):
        name = ad[f"D{r}"].value
        if name:
            wcs.append({"name": str(name).strip(), "hoursPerDay": float(ad[f"E{r}"].value or 8)})
    money_cats = [{"name": c, "direction": "In" if c.lower() in INCOME else "Out"} for c in column(ad, "I", 18, 36)]
    anchor = nv("SampleAnchor")
    data["settings"] = {
        "companyName": nv("CompanyName", "My Factory"),
        "companyAddress": nv("CompanyAddress", ""),
        "companyContact": nv("CompanyContact", ""),
        "labourRate": float(nv("LabourRate", 25)),
        "overheadPct": float(nv("OverheadPct", 0.3)),
        "useSalesTax": str(nv("UseSalesTax", "Yes")),
        "salesTaxName": nv("SalesTaxName", "Sales Tax"),
        "taxRate": float(nv("TaxRate", 0)),
        "planningWeeks": int(nv("PlanningWeeks", 8)),
        "pipelinePaidDays": int(nv("PipelinePaidDays", 30)),
        "dueDays": int(nv("DueDays", 15)),
        "sampleMode": str(nv("SampleMode", "No")),
        "sampleAnchor": anchor.strftime("%Y-%m-%d") if isinstance(anchor, (dt.datetime, dt.date)) else None,
        "workCenters": wcs,
        "itemCategories": column(ad, "G", 6, 31),
        "units": column(ad, "I", 6, 15),
        "payMethods": column(ad, "K", 6, 15),
        "itemTypes": column(ad, "D", 18, 27),
        "moneyCategories": money_cats,
        "roles": column(ad, "K", 18, 27),
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    print(dst, {k: len(v) for k, v in data.items() if isinstance(v, list)})


if __name__ == "__main__":
    main()
