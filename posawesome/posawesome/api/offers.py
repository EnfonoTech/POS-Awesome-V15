# -*- coding: utf-8 -*-
# Copyright (c) 2020, Youssef Restom and contributors
# For license information, please see license.txt

from __future__ import unicode_literals
import json

import frappe
from frappe.utils import cstr, flt, nowdate
from posawesome.posawesome.doctype.pos_coupon.pos_coupon import check_coupon_code
from posawesome.posawesome.doctype.delivery_charges.delivery_charges import (
    get_applicable_delivery_charges as _get_applicable_delivery_charges,
)


@frappe.whitelist()
def get_pos_coupon(coupon, customer, company):
    res = check_coupon_code(coupon, customer, company)
    return res


@frappe.whitelist()
def get_active_gift_coupons(customer, company):
    coupons = []
    coupons_data = frappe.get_all(
        "POS Coupon",
        filters={
            "company": company,
            "coupon_type": "Gift Card",
            "customer": customer,
            "used": 0,
        },
        fields=["coupon_code"],
    )
    if len(coupons_data):
        coupons = [i.coupon_code for i in coupons_data]
    return coupons


@frappe.whitelist()
def get_offers(profile):
    pos_profile = frappe.get_doc("POS Profile", profile)
    company = pos_profile.company
    warehouse = pos_profile.warehouse
    date = nowdate()

    values = {
        "company": company,
        "pos_profile": profile,
        "warehouse": warehouse,
        "valid_from": date,
        "valid_upto": date,
    }
    data = (
        frappe.db.sql(
            """
        SELECT *
        FROM `tabPOS Offer`
        WHERE
        disable = 0 AND
        company = %(company)s AND
        (pos_profile is NULL OR pos_profile  = '' OR  pos_profile = %(pos_profile)s) AND
        (warehouse is NULL OR warehouse  = '' OR  warehouse = %(warehouse)s) AND
        (valid_from is NULL OR valid_from  = '' OR  valid_from <= %(valid_from)s) AND
        (valid_upto is NULL OR valid_upto  = '' OR  valid_upto >= %(valid_upto)s)
    """,
            values=values,
            as_dict=1,
        )
        or []
    )

    _attach_combo_items(data)

    promotional_scheme_offers = _get_promotional_scheme_offers(pos_profile) or []

    return data + promotional_scheme_offers


def _attach_combo_items(offers):
    combo_offer_names = [d.name for d in offers if d.get("apply_on") == "Item Combination"]
    if not combo_offer_names:
        return

    combo_rows = frappe.get_all(
        "POS Offer Combo Item",
        filters={"parent": ["in", combo_offer_names]},
        fields=["parent", "item_code", "qty", "uom"],
        order_by="parent, idx",
    )

    item_codes = list({row.item_code for row in combo_rows if row.item_code})
    stock_uoms = {
        item.item_code: item.stock_uom
        for item in (
            frappe.get_all(
                "Item",
                filters={"item_code": ["in", item_codes]},
                fields=["item_code", "stock_uom"],
            )
            if item_codes
            else []
        )
    }

    combo_map = {}
    for row in combo_rows:
        stock_uom = stock_uoms.get(row.item_code)
        # Combo eligibility (getComboOffer) compares required qty against the cart's
        # stock_qty -- an offer defined as "1 Box" must be converted to stock-uom terms
        # (e.g. 3 Nos) using the item's own UOM Conversion Detail, exactly like the rest
        # of the app resolves uom conversions (see get_item_detail/calcUom).
        uom = row.uom or stock_uom
        combo_map.setdefault(row.parent, []).append(
            {
                "item_code": row.item_code,
                "qty": flt(row.qty) or 1,
                "uom": uom,
                "conversion_factor": _get_uom_conversion_factor(row.item_code, uom, stock_uom),
            }
        )

    for d in offers:
        if d.get("apply_on") == "Item Combination":
            d["combo_items"] = combo_map.get(d.name, [])


def _get_uom_conversion_factor(item_code, uom, stock_uom):
    if not uom or uom == stock_uom:
        return 1.0
    return (
        flt(
            frappe.db.get_value(
                "UOM Conversion Detail", {"parent": item_code, "uom": uom}, "conversion_factor"
            )
        )
        or 1.0
    )


@frappe.whitelist()
def get_combo_item_reference_rate(item_code, uom=None, pos_profile=None):
    """Resolve a reference rate for a POS Offer combo item row.

    Prefers the POS Profile's selling price list, falls back to the system default
    selling price list, then to Item.standard_rate -- scaling by the chosen uom's
    conversion factor against the item's stock uom whenever no uom-specific Item
    Price row exists, since standard_rate/most Item Price rows are stock-uom rates.
    """
    if not item_code:
        return None

    item = frappe.db.get_value("Item", item_code, ["stock_uom", "standard_rate"], as_dict=True)
    if not item:
        return None

    stock_uom = item.stock_uom
    uom = uom or stock_uom
    conversion_factor = _get_uom_conversion_factor(item_code, uom, stock_uom)

    price_list = None
    if pos_profile:
        price_list = frappe.db.get_value("POS Profile", pos_profile, "selling_price_list")
    if not price_list:
        price_list = frappe.db.get_single_value("Selling Settings", "selling_price_list")

    rate = None
    if price_list:
        rate = frappe.db.get_value(
            "Item Price",
            {"item_code": item_code, "price_list": price_list, "uom": uom, "selling": 1},
            "price_list_rate",
        )
        if not rate:
            stock_rate = frappe.db.get_value(
                "Item Price",
                {"item_code": item_code, "price_list": price_list, "uom": stock_uom, "selling": 1},
                "price_list_rate",
            )
            if stock_rate:
                rate = flt(stock_rate) * conversion_factor

    if not rate:
        rate = flt(item.standard_rate) * conversion_factor

    return {
        "rate": flt(rate),
        "uom": uom,
        "stock_uom": stock_uom,
        "conversion_factor": conversion_factor,
        "price_list": price_list,
    }


@frappe.whitelist()
def get_applicable_delivery_charges(company, pos_profile, customer, shipping_address_name=None):
    return _get_applicable_delivery_charges(company, pos_profile, customer, shipping_address_name)


def _get_promotional_scheme_offers(pos_profile):
    if not frappe.db.table_exists("Promotional Scheme"):
        return []

    date = nowdate()
    values = {"company": pos_profile.company, "date": date}

    try:
        promotional_schemes = frappe.db.sql(
            """
            SELECT name
            FROM `tabPromotional Scheme`
            WHERE
                disable = 0
                AND selling = 1
                AND company = %(company)s
                AND (valid_from IS NULL OR valid_from = '' OR valid_from <= %(date)s)
                AND (valid_upto IS NULL OR valid_upto = '' OR valid_upto >= %(date)s)
            """,
            values=values,
            as_dict=True,
        )
    except Exception:
        frappe.log_error(frappe.get_traceback(), "POS Awesome - Failed to fetch Promotional Schemes")
        return []

    offers = []
    for row in promotional_schemes:
        try:
            scheme = frappe.get_doc("Promotional Scheme", row.name)
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"POS Awesome - Unable to load Promotional Scheme {row.name}",
            )
            continue

        offers.extend(_prepare_promotional_scheme_offers(scheme, pos_profile))

    return offers


def _prepare_promotional_scheme_offers(scheme, pos_profile):
    # Skip schemes with party specific or unsupported configurations for POS logic
    if scheme.applicable_for or scheme.apply_rule_on_other:
        return []

    if scheme.mixed_conditions or scheme.is_cumulative:
        return []

    offers = []
    offers.extend(_build_price_discount_offers(scheme, pos_profile))
    offers.extend(_build_product_discount_offers(scheme, pos_profile))
    return [offer for offer in offers if offer]


def _build_price_discount_offers(scheme, pos_profile):
    slabs = getattr(scheme, "price_discount_slabs", [])
    if not slabs:
        return []

    targets = _get_scheme_targets(scheme)
    profile_price_list = getattr(pos_profile, "selling_price_list", None)
    profile_warehouse = getattr(pos_profile, "warehouse", None)

    offers = []

    for slab in slabs:
        if slab.disable:
            continue

        if slab.for_price_list and profile_price_list and slab.for_price_list != profile_price_list:
            continue

        if slab.warehouse and profile_warehouse and slab.warehouse != profile_warehouse:
            continue

        offer_template = {
            "name": _make_offer_identifier(scheme.name, slab.name),
            "row_id": _make_offer_identifier(scheme.name, slab.name),
            "title": scheme.name,
            "description": slab.rule_description or scheme.name,
            "company": scheme.company,
            "pos_profile": pos_profile.name,
            "warehouse": slab.warehouse,
            "apply_on": scheme.apply_on,
            "apply_type": scheme.apply_on if scheme.apply_on in ("Item Code", "Item Group") else "",
            "offer": "Grand Total" if scheme.apply_on == "Transaction" else "Item Price",
            "auto": 1,
            "coupon_based": 0,
            "offer_applied": 0,
            "min_qty": flt(slab.min_qty),
            "max_qty": flt(slab.max_qty),
            "min_amt": flt(slab.min_amount),
            "max_amt": flt(slab.max_amount),
            "discount_type": _map_discount_type(slab.rate_or_discount),
            "rate": flt(slab.rate),
            "discount_amount": flt(slab.discount_amount),
            "discount_percentage": flt(slab.discount_percentage),
            "given_qty": 0,
            "valid_from": scheme.valid_from,
            "valid_upto": scheme.valid_upto,
            "promo_source": "Promotional Scheme",
            "promotional_scheme": scheme.name,
            "promotional_scheme_rule": slab.name,
        }

        offer_template = _normalize_discount_fields(offer_template)

        if scheme.apply_on == "Transaction":
            offers.append(offer_template)
            continue

        if not targets:
            continue

        for target in targets:
            new_offer = offer_template.copy()
            new_offer["name"] = _make_offer_identifier(scheme.name, target, slab.name)
            new_offer["row_id"] = new_offer["name"]

            if scheme.apply_on == "Item Code":
                new_offer["item"] = target
                new_offer["apply_item_code"] = target
            elif scheme.apply_on == "Item Group":
                new_offer["item_group"] = target
                new_offer["apply_item_group"] = target
            elif scheme.apply_on == "Brand":
                new_offer["brand"] = target

            offers.append(new_offer)

    return offers


def _build_product_discount_offers(scheme, pos_profile):
    slabs = getattr(scheme, "product_discount_slabs", [])
    if not slabs:
        return []

    targets = _get_scheme_targets(scheme)
    profile_warehouse = getattr(pos_profile, "warehouse", None)

    offers = []

    for slab in slabs:
        if slab.disable:
            continue

        if slab.warehouse and profile_warehouse and slab.warehouse != profile_warehouse:
            continue

        if flt(slab.free_qty) <= 0:
            continue

        offer_template = {
            "name": _make_offer_identifier(scheme.name, slab.name),
            "row_id": _make_offer_identifier(scheme.name, slab.name),
            "title": scheme.name,
            "description": slab.rule_description or scheme.name,
            "company": scheme.company,
            "pos_profile": pos_profile.name,
            "warehouse": slab.warehouse,
            "apply_on": scheme.apply_on,
            "offer": "Give Product",
            "auto": 1,
            "coupon_based": 0,
            "offer_applied": 0,
            "min_qty": flt(slab.min_qty),
            "max_qty": flt(slab.max_qty),
            "min_amt": flt(slab.min_amount),
            "max_amt": flt(slab.max_amount),
            "given_qty": flt(slab.free_qty),
            "discount_type": "Rate" if flt(slab.free_item_rate) else "Discount Percentage",
            "rate": flt(slab.free_item_rate),
            "discount_amount": 0,
            "discount_percentage": 100 if not flt(slab.free_item_rate) else 0,
            "valid_from": scheme.valid_from,
            "valid_upto": scheme.valid_upto,
            "promo_source": "Promotional Scheme",
            "promotional_scheme": scheme.name,
            "promotional_scheme_rule": slab.name,
            "round_free_qty": slab.round_free_qty,
        }

        if slab.free_item and not slab.same_item:
            offer_template["give_item"] = slab.free_item
            offer_template["apply_item_code"] = slab.free_item

        offer_template = _normalize_discount_fields(offer_template)

        if scheme.apply_on == "Transaction":
            offers.append(offer_template)
            continue

        if not targets:
            continue

        for target in targets:
            new_offer = offer_template.copy()
            new_offer["name"] = _make_offer_identifier(scheme.name, target, slab.name)
            new_offer["row_id"] = new_offer["name"]

            if scheme.apply_on == "Item Code":
                new_offer["item"] = target
                new_offer["apply_type"] = "Item Code"
                new_offer["apply_item_code"] = target
                new_offer["replace_item"] = 1 if slab.same_item else 0
            elif scheme.apply_on == "Item Group":
                new_offer["item_group"] = target
                new_offer["apply_type"] = "Item Group"
                new_offer["apply_item_group"] = target
                if slab.same_item:
                    new_offer["replace_cheapest_item"] = 1
            elif scheme.apply_on == "Brand":
                new_offer["brand"] = target
                if slab.same_item:
                    new_offer["replace_cheapest_item"] = 1

            offers.append(new_offer)

    return offers


def _get_scheme_targets(scheme):
    targets = []
    if scheme.apply_on == "Item Code":
        targets = [row.item_code for row in scheme.items if row.item_code]
    elif scheme.apply_on == "Item Group":
        targets = [row.item_group for row in scheme.item_groups if row.item_group]
    elif scheme.apply_on == "Brand":
        targets = [row.brand for row in scheme.brands if row.brand]

    # Remove duplicates while preserving order
    seen = set()
    unique_targets = []
    for target in targets:
        target_key = cstr(target)
        if target_key and target_key not in seen:
            seen.add(target_key)
            unique_targets.append(target_key)

    return unique_targets


def _map_discount_type(rate_or_discount):
    mapping = {
        "Rate": "Rate",
        "Discount Percentage": "Discount Percentage",
        "Discount Amount": "Discount Amount",
    }
    return mapping.get(rate_or_discount, "Discount Percentage")


def _normalize_discount_fields(offer):
    discount_type = offer.get("discount_type")

    if discount_type != "Rate":
        offer["rate"] = flt(0)

    if discount_type != "Discount Amount":
        offer["discount_amount"] = flt(0)

    if discount_type != "Discount Percentage":
        offer["discount_percentage"] = flt(0)

    return offer


def _make_offer_identifier(*parts):
    cleaned = [frappe.scrub(cstr(part)) for part in parts if part]
    if not cleaned:
        cleaned = [frappe.generate_hash(length=10)]
    return "ps-" + "-".join(cleaned)
