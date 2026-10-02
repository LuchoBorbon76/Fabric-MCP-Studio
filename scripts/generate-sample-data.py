"""Generate the synthetic retail dataset used by the Fabric MCP demo.

Standard library only. Output is deterministic for a given --seed so the
committed CSVs, demo script and expected answers stay in sync.

Story baked into the data (so live questions have interesting answers):
  * Seasonality: November/December peaks, January dip, ~8% YoY growth.
  * The Central region underperforms in 2026 (~15% fewer orders).
  * Three stores opened in 2025, so "same-store sales" differs from total sales.
  * ~15% of customers stopped buying months ago -> "at-risk customer" rule hits.
  * A handful of products sit below the 20% minimum margin -> rule violations.
  * Some returns were processed after the 30-day window -> rule violations.

Outputs:
  data/retail/*.csv          human-readable copies
  data/retail/parquet/*.parquet  typed copies (written when pyarrow is installed).
      Lakehouse "Load to tables" can't take an explicit schema for CSV, so the
      deploy script loads the Parquet files to get deterministic column types.

Usage:
    python scripts/generate-sample-data.py [--out data/retail] [--seed 42]
    pip install pyarrow   # optional, enables the Parquet export
"""

from __future__ import annotations

import argparse
import csv
import random
from datetime import date, timedelta
from pathlib import Path

START = date(2024, 1, 1)
END = date(2026, 9, 30)

FIRST_NAMES = [
    "Ava", "Liam", "Sofia", "Noah", "Mia", "Mateo", "Isabella", "Lucas", "Camila", "Ethan",
    "Valentina", "James", "Emma", "Diego", "Olivia", "Daniel", "Lucia", "Henry", "Grace", "Leo",
    "Chloe", "Samuel", "Zoe", "Gabriel", "Aria", "Adrian", "Nora", "Julian", "Elena", "Owen",
    "Priya", "Arjun", "Mei", "Kenji", "Fatima", "Omar", "Amara", "Kofi", "Ingrid", "Lars",
]
LAST_NAMES = [
    "Garcia", "Smith", "Martinez", "Johnson", "Lopez", "Brown", "Hernandez", "Davis", "Gonzalez",
    "Miller", "Wilson", "Anderson", "Thomas", "Moore", "Jackson", "Martin", "Lee", "Perez",
    "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker",
    "Young", "Allen", "King", "Patel", "Nguyen", "Kim", "Chen", "Okafor", "Silva", "Rossi",
]
CITIES = [
    ("Seattle", "WA", "West"), ("Portland", "OR", "West"), ("San Francisco", "CA", "West"),
    ("Los Angeles", "CA", "West"), ("Denver", "CO", "Central"), ("Chicago", "IL", "Central"),
    ("Minneapolis", "MN", "Central"), ("Kansas City", "MO", "Central"), ("Dallas", "TX", "South"),
    ("Austin", "TX", "South"), ("Atlanta", "GA", "South"), ("Miami", "FL", "South"),
    ("New York", "NY", "East"), ("Boston", "MA", "East"), ("Philadelphia", "PA", "East"),
    ("Washington", "DC", "East"),
]
CATALOG = {
    "Electronics": {"Audio": (40, 350), "Wearables": (80, 450), "Accessories": (10, 90)},
    "Home": {"Kitchen": (15, 250), "Decor": (10, 180), "Bedding": (30, 260)},
    "Apparel": {"Men": (20, 160), "Women": (20, 190), "Kids": (10, 80)},
    "Outdoor": {"Camping": (25, 400), "Fitness": (15, 300)},
    "Beauty": {"Skincare": (8, 120), "Fragrance": (30, 160)},
}
BRANDS = [
    "Contoso", "Fabrikam", "Northwind", "Tailspin", "Woodgrove", "Litware",
    "Proseware", "Adventure Works", "Wide World Importers", "Alpine Ski House",
]
ADJECTIVES = ["Classic", "Pro", "Lite", "Max", "Eco", "Urban", "Trail", "Smart", "Essential", "Premium"]
NOUNS = {
    "Audio": ["Headphones", "Earbuds", "Speaker", "Soundbar"],
    "Wearables": ["Smartwatch", "Fitness Band", "Smart Ring"],
    "Accessories": ["Charger", "Cable", "Phone Case", "Power Bank"],
    "Kitchen": ["Blender", "Knife Set", "Cookware Set", "Coffee Maker"],
    "Decor": ["Lamp", "Vase", "Wall Art", "Candle Set"],
    "Bedding": ["Duvet", "Pillow Set", "Sheet Set", "Throw Blanket"],
    "Men": ["Jacket", "Polo", "Chinos", "Sneakers"],
    "Women": ["Dress", "Blazer", "Leggings", "Boots"],
    "Kids": ["Hoodie", "T-Shirt", "Rain Jacket", "Sneakers"],
    "Camping": ["Tent", "Sleeping Bag", "Backpack", "Camp Stove"],
    "Fitness": ["Yoga Mat", "Dumbbell Set", "Resistance Bands", "Water Bottle"],
    "Skincare": ["Moisturizer", "Serum", "Cleanser", "Sunscreen"],
    "Fragrance": ["Eau de Parfum", "Body Mist", "Cologne"],
}
RETURN_REASONS = ["Damaged", "Wrong size", "Not as described", "Changed mind", "Defective", "Late delivery"]
MONTH_WEIGHT = {1: 0.8, 2: 0.85, 3: 0.95, 4: 1.0, 5: 1.0, 6: 1.0, 7: 1.0, 8: 1.05, 9: 1.0, 10: 1.05, 11: 1.4, 12: 1.8}

# Column types for the Parquet export. Keep in sync with ontology/retail/tables/*.tmdl.
SCHEMAS = {
    "stores": {"StoreId": "string", "StoreName": "string", "Channel": "string", "City": "string", "State": "string",
               "Region": "string", "OpenDate": "date", "SquareFeet": "int64"},
    "products": {"ProductId": "string", "ProductName": "string", "Category": "string", "Subcategory": "string",
                 "Brand": "string", "UnitCost": "double", "ListPrice": "double"},
    "customers": {"CustomerId": "string", "CustomerName": "string", "Email": "string", "Segment": "string",
                  "LoyaltyTier": "string", "City": "string", "State": "string", "Region": "string",
                  "SignupDate": "date"},
    "sales": {"SalesLineId": "int64", "OrderId": "string", "OrderDate": "date", "CustomerId": "string",
              "StoreId": "string", "ProductId": "string", "Quantity": "int64", "UnitPrice": "double",
              "DiscountPct": "double", "UnitCost": "double"},
    "returns": {"ReturnId": "string", "SalesLineId": "int64", "ReturnDate": "date", "Quantity": "int64",
                "Reason": "string"},
    "dates": {"Date": "date", "Year": "int64", "Quarter": "string", "MonthNumber": "int64", "MonthName": "string",
              "YearMonth": "string", "WeekOfYear": "int64", "DayOfWeek": "string", "IsWeekend": "bool",
              "FiscalYear": "string", "FiscalQuarter": "string"},
}


def daterange(start: date, end: date):
    for n in range((end - start).days + 1):
        yield start + timedelta(days=n)


def write_csv(path: Path, header: list[str], rows: list[list]) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        writer.writerows(rows)
    print(f"  {path.name:<14} {len(rows):>6} rows")


def build_stores(rng: random.Random) -> list[dict]:
    stores = []
    for i, (city, state, region) in enumerate(CITIES, start=1):
        stores.append({"StoreId": f"S{i:02d}", "StoreName": f"{city} Store", "Channel": "Store",
                       "City": city, "State": state, "Region": region,
                       "OpenDate": date(rng.randint(2012, 2022), rng.randint(1, 12), 1),
                       "SquareFeet": rng.choice([12000, 18000, 24000, 32000])})
    for store_id, (month, day) in zip(["S04", "S09", "S14"], [(3, 1), (6, 15), (9, 1)]):
        next(s for s in stores if s["StoreId"] == store_id)["OpenDate"] = date(2025, month, day)
    stores.append({"StoreId": "S17", "StoreName": "Online Web", "Channel": "Online", "City": "",
                   "State": "", "Region": "Digital", "OpenDate": date(2015, 1, 1), "SquareFeet": 0})
    stores.append({"StoreId": "S18", "StoreName": "Online App", "Channel": "Online", "City": "",
                   "State": "", "Region": "Digital", "OpenDate": date(2019, 5, 1), "SquareFeet": 0})
    return stores


def build_products(rng: random.Random) -> list[dict]:
    products, n = [], 1
    for category, subs in CATALOG.items():
        for sub, (lo, hi) in subs.items():
            for _ in range(rng.randint(6, 8)):
                brand = rng.choice(BRANDS)
                price = round(rng.uniform(lo, hi), 2)
                margin = rng.uniform(0.25, 0.6)
                products.append({"ProductId": f"P{n:03d}",
                                 "ProductName": f"{brand} {rng.choice(ADJECTIVES)} {rng.choice(NOUNS[sub])}",
                                 "Category": category, "Subcategory": sub, "Brand": brand,
                                 "UnitCost": round(price * (1 - margin), 2), "ListPrice": price})
                n += 1
    for p in rng.sample(products, 6):
        p["UnitCost"] = round(p["ListPrice"] * rng.uniform(0.84, 0.95), 2)
    return products


def build_customers(rng: random.Random, count: int) -> list[dict]:
    customers = []
    for i in range(1, count + 1):
        first, last = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
        city, state, region = rng.choice(CITIES)
        if rng.random() < 0.7:
            signup = START - timedelta(days=rng.randint(0, 1500))
        else:
            signup = START + timedelta(days=rng.randint(0, 900))
        churned = rng.random() < 0.15
        active_until = date(2025, 1, 1) + timedelta(days=rng.randint(0, 480)) if churned else END
        customers.append({"CustomerId": f"C{i:04d}", "CustomerName": f"{first} {last}",
                          "Email": f"{first.lower()}.{last.lower()}{i}@example.com",
                          "Segment": rng.choices(["Consumer", "Small Business", "Corporate"], [0.75, 0.18, 0.07])[0],
                          "LoyaltyTier": rng.choices(["Bronze", "Silver", "Gold", "Platinum"], [0.5, 0.3, 0.15, 0.05])[0],
                          "City": city, "State": state, "Region": region, "SignupDate": signup,
                          "_active_from": max(signup, START), "_active_until": active_until,
                          "_weight": rng.uniform(0.3, 3.0)})
    return customers


def build_sales(rng: random.Random, customers, products, stores, orders_per_day: float):
    sales, returns = [], []
    line_id, order_no, return_no = 1, 100001, 1
    physical = [s for s in stores if s["Channel"] == "Store"]
    online = [s for s in stores if s["Channel"] == "Online"]
    for day in daterange(START, END):
        years = (day - START).days / 365.0
        expected = orders_per_day * MONTH_WEIGHT[day.month] * (1.08 ** years) * (1.15 if day.weekday() >= 5 else 1.0)
        for _ in range(max(0, int(rng.gauss(expected, expected ** 0.5)))):
            pool = [c for c in rng.sample(customers, 25) if c["_active_from"] <= day <= c["_active_until"]]
            if not pool:
                continue
            customer = rng.choices(pool, [c["_weight"] for c in pool])[0]
            if rng.random() < 0.35:
                store = rng.choice(online)
            else:
                local = [s for s in physical if s["Region"] == customer["Region"] and s["OpenDate"] <= day]
                store = rng.choice(local or [s for s in physical if s["OpenDate"] <= day])
            if store["Region"] == "Central" and day.year == 2026 and rng.random() < 0.15:
                continue
            order_id = f"SO{order_no}"
            order_no += 1
            line_count = rng.choices([1, 2, 3, 4, 5], [0.35, 0.3, 0.18, 0.12, 0.05])[0]
            for product in rng.sample(products, line_count):
                qty = rng.choices([1, 2, 3, 4], [0.7, 0.2, 0.07, 0.03])[0]
                discount = rng.choices([0.0, 0.05, 0.1, 0.15, 0.25], [0.6, 0.15, 0.12, 0.08, 0.05])[0]
                if day.month in (11, 12) and rng.random() < 0.3:
                    discount = max(discount, 0.2)
                sales.append([line_id, order_id, day.isoformat(), customer["CustomerId"], store["StoreId"],
                              product["ProductId"], qty, product["ListPrice"], discount, product["UnitCost"]])
                if rng.random() < 0.045 and day < END - timedelta(days=5):
                    lag = rng.randint(1, 28) if rng.random() < 0.88 else rng.randint(31, 60)
                    returns.append([f"R{return_no:05d}", line_id, min(day + timedelta(days=lag), END).isoformat(),
                                    rng.randint(1, qty), rng.choice(RETURN_REASONS)])
                    return_no += 1
                line_id += 1
    return sales, returns


def build_dates() -> list[list]:
    rows = []
    for d in daterange(date(2023, 7, 1), date(2027, 6, 30)):
        fiscal_year = d.year + 1 if d.month >= 7 else d.year
        fiscal_quarter = ((d.month - 7) % 12) // 3 + 1
        rows.append([d.isoformat(), d.year, f"Q{(d.month - 1) // 3 + 1}", d.month, d.strftime("%B"),
                     d.strftime("%Y-%m"), d.isocalendar()[1], d.strftime("%A"), d.weekday() >= 5,
                     f"FY{fiscal_year % 100:02d}", f"FY{fiscal_year % 100:02d} Q{fiscal_quarter}"])
    return rows


def export_parquet(out: Path) -> None:
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError:
        print("  (pyarrow not installed - skipping Parquet export; run 'pip install pyarrow')")
        return
    casts = {
        "string": (pa.string(), lambda v: v if v != "" else None),
        "int64": (pa.int64(), int),
        "double": (pa.float64(), float),
        "date": (pa.date32(), date.fromisoformat),
        "bool": (pa.bool_(), lambda v: v == "True"),
    }
    target = out / "parquet"
    target.mkdir(exist_ok=True)
    for table, schema in SCHEMAS.items():
        with (out / f"{table}.csv").open(encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
        arrays, fields = [], []
        for column, kind in schema.items():
            arrow_type, convert = casts[kind]
            arrays.append(pa.array([convert(r[column]) for r in rows], type=arrow_type))
            fields.append(pa.field(column, arrow_type))
        pq.write_table(pa.Table.from_arrays(arrays, schema=pa.schema(fields)), target / f"{table}.parquet",
                       compression="snappy")
    print(f"  parquet/       {len(SCHEMAS):>6} typed files")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data" / "retail"))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--customers", type=int, default=800)
    parser.add_argument("--orders-per-day", type=float, default=9.0)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    print(f"Writing retail dataset to {out} (seed={args.seed})")

    stores = build_stores(rng)
    products = build_products(rng)
    customers = build_customers(rng, args.customers)
    sales, returns = build_sales(rng, customers, products, stores, args.orders_per_day)

    write_csv(out / "stores.csv",
              ["StoreId", "StoreName", "Channel", "City", "State", "Region", "OpenDate", "SquareFeet"],
              [[s["StoreId"], s["StoreName"], s["Channel"], s["City"], s["State"], s["Region"],
                s["OpenDate"].isoformat(), s["SquareFeet"]] for s in stores])
    write_csv(out / "products.csv",
              ["ProductId", "ProductName", "Category", "Subcategory", "Brand", "UnitCost", "ListPrice"],
              [[p["ProductId"], p["ProductName"], p["Category"], p["Subcategory"], p["Brand"],
                p["UnitCost"], p["ListPrice"]] for p in products])
    write_csv(out / "customers.csv",
              ["CustomerId", "CustomerName", "Email", "Segment", "LoyaltyTier", "City", "State", "Region", "SignupDate"],
              [[c["CustomerId"], c["CustomerName"], c["Email"], c["Segment"], c["LoyaltyTier"], c["City"],
                c["State"], c["Region"], c["SignupDate"].isoformat()] for c in customers])
    write_csv(out / "sales.csv",
              ["SalesLineId", "OrderId", "OrderDate", "CustomerId", "StoreId", "ProductId", "Quantity",
               "UnitPrice", "DiscountPct", "UnitCost"], sales)
    write_csv(out / "returns.csv", ["ReturnId", "SalesLineId", "ReturnDate", "Quantity", "Reason"], returns)
    write_csv(out / "dates.csv",
              ["Date", "Year", "Quarter", "MonthNumber", "MonthName", "YearMonth", "WeekOfYear", "DayOfWeek",
               "IsWeekend", "FiscalYear", "FiscalQuarter"], build_dates())
    export_parquet(out)


if __name__ == "__main__":
    main()
