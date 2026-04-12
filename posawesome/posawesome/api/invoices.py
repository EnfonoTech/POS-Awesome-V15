# Copyright (c) 2020, Youssef Restom and contributors
# For license information, please see license.txt

import json

import frappe
from erpnext.accounts.doctype.sales_invoice.sales_invoice import get_bank_cash_account
from erpnext.selling.doctype.sales_order.sales_order import make_sales_invoice
from erpnext.setup.utils import get_exchange_rate
from erpnext.stock.doctype.batch.batch import (
    get_batch_no,
    get_batch_qty,
)  # This should be from erpnext directly
from frappe import _
from frappe.utils import (
    cint,
    cstr,
    flt,
    formatdate,
    getdate,
    money_in_words,
    nowdate,
    strip_html_tags,
)
from frappe.utils.background_jobs import enqueue

from posawesome.posawesome.api.payments import (
    redeeming_customer_credit,
)  # Updated import
from posawesome.posawesome.api.utilities import (
    ensure_child_doctype,
    set_batch_nos_for_bundels,
)  # Updated imports

from .items import get_stock_availability


def _sanitize_item_name(name: str) -> str:
    """Strip HTML and limit length for item names."""
    if not name:
        return ""
    cleaned = strip_html_tags(name)
    return cleaned.strip()[:140]


def _apply_item_name_overrides(invoice_doc, overrides=None):
    """Apply custom item names to invoice items."""
    overrides = overrides or {}
    for item in invoice_doc.items:
        source = overrides.get(item.idx) or {}
        provided = source.get("item_name") if isinstance(source, dict) else None
        default_name = frappe.get_cached_value("Item", item.item_code, "item_name")
        clean = _sanitize_item_name(provided or item.item_name)
        if clean and clean != default_name:
            item.item_name = clean
            item.name_overridden = 1
        else:
            item.item_name = default_name
            item.name_overridden = 0


def _pos_invoice_sql_context_for_profile(pos_profile):
    """Match get_sales_invoice_list table choice (POS Invoice vs Sales Invoice)."""
    use_pos_invoice = False
    if pos_profile:
        use_pos_invoice = cint(
            frappe.db.get_value(
                "POS Profile",
                pos_profile,
                "create_pos_invoice_instead_of_sales_invoice",
            )
        )
    table_name = "tabPOS Invoice" if use_pos_invoice else "tabSales Invoice"
    doctype_name = "POS Invoice" if use_pos_invoice else "Sales Invoice"
    if use_pos_invoice and pos_profile:
        pos_count = frappe.db.count("POS Invoice", filters={"pos_profile": pos_profile})
        if not pos_count:
            table_name = "tabSales Invoice"
            doctype_name = "Sales Invoice"
            use_pos_invoice = False
    item_table = "`tabPOS Invoice Item`" if doctype_name == "POS Invoice" else "`tabSales Invoice Item`"
    return {
        "table_name": table_name,
        "doctype_name": doctype_name,
        "item_table": item_table,
        "use_pos_invoice": use_pos_invoice,
    }


def _get_max_billing_only_invoices_pending_dn_per_day():
    if not frappe.db.exists("DocType", "Fateh POS Settings"):
        return 0
    try:
        doc = frappe.get_cached_doc("Fateh POS Settings", "Fateh POS Settings")
    except Exception:
        return 0
    return cint(getattr(doc, "max_billing_only_invoices_pending_dn_per_day", None) or 0)


def count_billing_only_invoices_pending_delivery_note(pos_profile, posting_date, exclude_invoice_name=None):
    """Submitted POS billing-only invoices (update_stock off) with qty left to deliver, same posting date."""
    if not pos_profile:
        return 0
    ctx = _pos_invoice_sql_context_for_profile(pos_profile)
    tn = ctx["table_name"]
    if tn not in ("tabSales Invoice", "tabPOS Invoice"):
        return 0
    conditions = """
        si.pos_profile = %(pos_profile)s
        AND si.docstatus = 1
        AND IFNULL(si.is_return, 0) = 0
        AND IFNULL(si.is_pos, 0) = 1
        AND IFNULL(si.update_stock, 0) = 0
        AND si.posting_date = %(posting_date)s
    """
    conditions += f"""
        AND EXISTS (
            SELECT 1 FROM {ctx["item_table"]} sii
            WHERE sii.parent = si.name
            AND sii.parenttype = %(dn_item_parenttype)s
            AND IFNULL(sii.delivered_by_supplier, 0) = 0
            AND (sii.qty - IFNULL(sii.delivered_qty, 0)) > 0.0000001
        )
    """
    values = {
        "pos_profile": pos_profile,
        "posting_date": getdate(posting_date or nowdate()),
        "dn_item_parenttype": ctx["doctype_name"],
    }
    if exclude_invoice_name:
        conditions += " AND si.name != %(exclude_invoice)s"
        values["exclude_invoice"] = exclude_invoice_name
    row = frappe.db.sql(
        f"SELECT COUNT(*) AS c FROM `{tn}` si WHERE {conditions}",
        values,
        as_dict=True,
    )
    return cint(row[0].c) if row else 0


def _validate_billing_only_dn_daily_quota_before_submit(invoice_doc):
    if not invoice_doc or not getattr(invoice_doc, "pos_profile", None):
        return
    if not cint(getattr(invoice_doc, "is_pos", 0)):
        return
    if cint(getattr(invoice_doc, "update_stock", 0)):
        return
    max_lim = _get_max_billing_only_invoices_pending_dn_per_day()
    if max_lim <= 0:
        return
    pd = getdate(invoice_doc.posting_date or nowdate())
    cnt = count_billing_only_invoices_pending_delivery_note(invoice_doc.pos_profile, pd)
    if cnt >= max_lim:
        frappe.throw(
            _(
                "Limit of {0} billing-only invoice(s) (Update stock off) awaiting delivery has been reached for this POS on {1}. Create delivery notes for existing invoices or keep Update stock on."
            ).format(max_lim, formatdate(pd))
        )


@frappe.whitelist()
def get_billing_only_dn_quota_status(pos_profile, posting_date=None):
    pos_profile = cstr(pos_profile or "").strip()
    if not pos_profile:
        return {
            "max": 0,
            "current": 0,
            "at_limit": False,
            "can_turn_off_update_stock": True,
        }
    posting_date = getdate(posting_date or nowdate())
    max_lim = _get_max_billing_only_invoices_pending_dn_per_day()
    current = count_billing_only_invoices_pending_delivery_note(pos_profile, posting_date)
    at_limit = max_lim > 0 and current >= max_lim
    can_turn_off = max_lim == 0 or current < max_lim
    return {
        "max": max_lim,
        "current": current,
        "at_limit": at_limit,
        "can_turn_off_update_stock": can_turn_off,
    }


def _get_available_stock(item):
    """Return available stock qty for an item row."""
    warehouse = item.get("warehouse")
    batch_no = item.get("batch_no")
    item_code = item.get("item_code")
    if not item_code or not warehouse:
        return 0
    if batch_no:
        return get_batch_qty(batch_no, warehouse) or 0
    return get_stock_availability(item_code, warehouse)


def _is_stock_item(item):
    """Return True when the provided row represents a stock item."""

    if item is None:
        return False

    flag = item.get("is_stock_item")
    if flag is not None:
        return bool(cint(flag))

    item_code = item.get("item_code")
    if not item_code:
        return False

    return bool(cint(frappe.get_cached_value("Item", item_code, "is_stock_item") or 0))


def _collect_stock_errors(items):
    """Return list of items exceeding available stock."""
    errors = []
    for d in items:
        if flt(d.get("qty")) < 0:
            continue
        if not _is_stock_item(d):
            continue
        available = _get_available_stock(d)
        requested = flt(d.get("stock_qty") or (flt(d.get("qty")) * flt(d.get("conversion_factor") or 1)))
        if requested > available:
            errors.append(
                {
                    "item_code": d.get("item_code"),
                    "warehouse": d.get("warehouse"),
                    "requested_qty": requested,
                    "available_qty": available,
                }
            )
    return errors


def _merge_duplicate_taxes(invoice_doc):
    """Remove duplicate tax rows with same account and rate.

    If duplicates are found, keep the first occurrence and recalculate totals.
    """
    seen = set()
    unique = []
    for tax in invoice_doc.get("taxes", []):
        key = (tax.account_head, flt(tax.rate), cstr(tax.charge_type))
        if key in seen:
            continue
        seen.add(key)
        unique.append(tax)
    if len(unique) != len(invoice_doc.get("taxes", [])):
        invoice_doc.set("taxes", unique)
        invoice_doc.calculate_taxes_and_totals()


def _should_block(pos_profile):
    allow_negative = cint(frappe.db.get_single_value("Stock Settings", "allow_negative_stock") or 0)
    if allow_negative:
        return False

    block_sale = 1
    if pos_profile:
        block_sale = cint(
            frappe.db.get_value("POS Profile", pos_profile, "posa_block_sale_beyond_available_qty") or 1
        )

    return bool(block_sale)


def _validate_stock_on_invoice(invoice_doc):
    if not cint(getattr(invoice_doc, "update_stock", 0)):
        frappe.logger().debug("Skipping stock validation: update_stock is disabled on invoice")
        return
    items_to_check = [d.as_dict() for d in invoice_doc.items if d.get("is_stock_item")]
    if hasattr(invoice_doc, "packed_items"):
        items_to_check.extend([d.as_dict() for d in invoice_doc.packed_items])
    errors = _collect_stock_errors(items_to_check)
    if errors and _should_block(invoice_doc.pos_profile):
        frappe.throw(frappe.as_json({"errors": errors}), frappe.ValidationError)


def _auto_set_return_batches(invoice_doc):
    """Assign batch numbers for return invoices without a source invoice.

    When the POS Profile allows returns without an original invoice and an
    item requires a batch number, this function allocates the first
    available batch in FIFO order. If no batches exist in the selected
    warehouse, an informative error is raised instead of the generic
    validation error.
    """

    if not invoice_doc.is_return or invoice_doc.get("return_against"):
        return

    profile = invoice_doc.get("pos_profile")
    allow_without_invoice = profile and frappe.db.get_value(
        "POS Profile", profile, "posa_allow_return_without_invoice"
    )
    if not cint(allow_without_invoice):
        return

    allow_free = cint(frappe.db.get_value("POS Profile", profile, "posa_allow_free_batch_return") or 0)

    for d in invoice_doc.items:
        if not d.get("item_code") or not d.get("warehouse"):
            continue

        has_batch = frappe.db.get_value("Item", d.item_code, "has_batch_no")
        if has_batch and not d.get("batch_no"):
            batch_list = get_batch_qty(item_code=d.item_code, warehouse=d.warehouse) or []
            batch_list = [b for b in batch_list if flt(b.get("qty")) > 0]
            if batch_list:
                # FIFO: batches are already sorted by posting/expiry in ERPNext
                d.batch_no = batch_list[0].get("batch_no")
            elif not allow_free:
                frappe.throw(_("No batches available in {0} for {1}.").format(d.warehouse, d.item_code))


@frappe.whitelist()
def validate_cart_items(items, pos_profile=None, update_stock=None):
    """Validate cart items for available stock.

    Returns a list of item dicts where requested quantity exceeds availability.
    This can be used on the front-end for pre-submission checks.
    """

    if isinstance(items, str):
        items = json.loads(items)

    if pos_profile and not frappe.db.exists("POS Profile", pos_profile):
        pos_profile = None

    if update_stock is not None and not cint(update_stock):
        return []

    if not _should_block(pos_profile):
        return []

    errors = _collect_stock_errors(items)
    if not errors:
        return []

    return errors


def get_default_return_reason():
    """Get default return reason from Fateh POS Settings."""
    default_reason = "Goods returned"
    try:
        if frappe.db.exists("Fateh POS Settings", "Fateh POS Settings"):
            settings = frappe.get_cached_doc("Fateh POS Settings", "Fateh POS Settings")
            default_reason = settings.get("default_return_reason") or "Goods returned"
    except Exception:
        pass
    return default_reason


def get_latest_rate(from_currency: str, to_currency: str):
    """Return the most recent Currency Exchange rate and its date."""
    rate_doc = frappe.get_all(
        "Currency Exchange",
        filters={"from_currency": from_currency, "to_currency": to_currency},
        fields=["exchange_rate", "date"],
        order_by="date desc, creation desc",
        limit=1,
    )
    if rate_doc:
        return flt(rate_doc[0].exchange_rate), rate_doc[0].date
    rate = get_exchange_rate(from_currency, to_currency, nowdate())
    return flt(rate), nowdate()


@frappe.whitelist()
def validate_return_items(original_invoice_name, return_items, doctype="Sales Invoice"):
    """
    Ensure that return items do not exceed the quantity from the original invoice.
    """
    original_invoice = frappe.get_doc(doctype, original_invoice_name)
    original_item_qty = {}

    for item in original_invoice.items:
        original_item_qty[item.item_code] = original_item_qty.get(item.item_code, 0) + item.qty

    returned_items = frappe.get_all(
        doctype,
        filters={
            "return_against": original_invoice_name,
            "docstatus": 1,
            "is_return": 1,
        },
        fields=["name"],
    )

    for returned_invoice in returned_items:
        ret_doc = frappe.get_doc(doctype, returned_invoice.name)
        for item in ret_doc.items:
            if item.item_code in original_item_qty:
                original_item_qty[item.item_code] -= abs(item.qty)

    for item in return_items:
        item_code = item.get("item_code")
        return_qty = abs(item.get("qty", 0))
        if item_code in original_item_qty and return_qty > original_item_qty[item_code]:
            return {
                "valid": False,
                "message": _("You are trying to return more quantity for item {0} than was sold.").format(
                    item_code
                ),
            }

    return {"valid": True}


@frappe.whitelist()
def update_invoice(data):
    data = json.loads(data)
    # Determine doctype based on POS Profile setting
    pos_profile = data.get("pos_profile")
    doctype = "Sales Invoice"
    if pos_profile and frappe.db.get_value(
        "POS Profile", pos_profile, "create_pos_invoice_instead_of_sales_invoice"
    ):
        doctype = "POS Invoice"

    # Ensure the document type is set for new invoices to prevent validation errors
    data.setdefault("doctype", doctype)

    if data.get("name"):
        invoice_doc = frappe.get_doc(doctype, data.get("name"))
        invoice_doc.update(data)
    else:
        invoice_doc = frappe.get_doc(data)

    # Set currency from data before set_missing_values
    # Validate return items if this is a return invoice
    if (data.get("is_return") or invoice_doc.is_return) and invoice_doc.get("return_against"):
        validation = validate_return_items(
            invoice_doc.return_against,
            [d.as_dict() for d in invoice_doc.items],
            doctype=invoice_doc.doctype,
        )
        if not validation.get("valid"):
            frappe.throw(validation.get("message"))
    selected_currency = data.get("currency")
    price_list_currency = data.get("price_list_currency")
    if not price_list_currency and invoice_doc.get("selling_price_list"):
        price_list_currency = frappe.db.get_value("Price List", invoice_doc.selling_price_list, "currency")

    # Ensure customer exists before setting missing values
    customer_name = invoice_doc.get("customer")
    if customer_name and not frappe.db.exists("Customer", customer_name):
        try:
            cust = frappe.get_doc(
                {
                    "doctype": "Customer",
                    "customer_name": customer_name,
                    "customer_group": "All Customer Groups",
                    "territory": "All Territories",
                    "customer_type": "Individual",
                }
            )
            cust.flags.ignore_permissions = True
            cust.insert()
            invoice_doc.customer = cust.name
            invoice_doc.customer_name = cust.customer_name
        except Exception as e:
            frappe.log_error(f"Failed to create customer {customer_name}: {e}")

    # Preserve provided item names for manual overrides
    overrides = {d.idx: {"item_name": d.item_name} for d in invoice_doc.items}
    locked_items = {}
    if invoice_doc.is_return:
        # Set custom_return_reason if not already set (mandatory field for returns)
        # For Sales Invoice returns, it must be provided from frontend
        if not invoice_doc.get("custom_return_reason"):
            # Check if reason is provided in data (from frontend)
            if data.get("custom_return_reason"):
                invoice_doc.custom_return_reason = data.get("custom_return_reason")
            else:
                # For Sales Invoice, throw error if reason not provided
                if doctype == "Sales Invoice":
                    frappe.throw(_("Return reason is mandatory for Sales Invoice returns. Please provide a return reason."))
                # For POS Invoice, use default from settings
                invoice_doc.custom_return_reason = get_default_return_reason()
        
        for d in invoice_doc.items:
            if d.get("locked_price"):
                locked_items[d.idx] = {
                    "rate": d.rate,
                    "price_list_rate": d.price_list_rate,
                    "discount_percentage": d.discount_percentage,
                    "discount_amount": d.discount_amount,
                    "is_free_item": d.get("is_free_item"),
                }

    invoice_doc.ignore_pricing_rule = 1
    invoice_doc.flags.ignore_pricing_rule = True

    # Set missing values first
    invoice_doc.set_missing_values()

    # Reapply any custom item names after defaults are set
    _apply_item_name_overrides(invoice_doc, overrides)

    # Remove duplicate taxes from item and profile templates
    _merge_duplicate_taxes(invoice_doc)

    if locked_items:
        for item in invoice_doc.items:
            locked = locked_items.get(item.idx)
            if locked:
                item.update(locked)
        invoice_doc.calculate_taxes_and_totals()

    # Ensure selected currency is preserved after set_missing_values
    if selected_currency:
        invoice_doc.currency = selected_currency
        company_currency = frappe.get_cached_value("Company", invoice_doc.company, "default_currency")
    price_list_currency = price_list_currency or company_currency

    conversion_rate = 1
    exchange_rate_date = invoice_doc.posting_date
    if invoice_doc.currency != company_currency:
        conversion_rate, exchange_rate_date = get_latest_rate(
            invoice_doc.currency,
            company_currency,
        )
        if not conversion_rate:
            frappe.throw(
                _(
                    "Unable to find exchange rate for {0} to {1}. Please create a Currency Exchange record manually"
                ).format(invoice_doc.currency, company_currency)
            )

        plc_conversion_rate = 1
        if price_list_currency != invoice_doc.currency:
            plc_conversion_rate, _ignored = get_latest_rate(
                price_list_currency,
                invoice_doc.currency,
            )
            if not plc_conversion_rate:
                frappe.throw(
                    _(
                        "Unable to find exchange rate for {0} to {1}. Please create a Currency Exchange record manually"
                    ).format(price_list_currency, invoice_doc.currency)
                )

        invoice_doc.conversion_rate = conversion_rate
        invoice_doc.plc_conversion_rate = plc_conversion_rate
        invoice_doc.price_list_currency = price_list_currency

        # Update rates and amounts for all items using multiplication
        for item in invoice_doc.items:
            if item.price_list_rate:
                item.base_price_list_rate = flt(
                    item.price_list_rate * (conversion_rate / plc_conversion_rate),
                    item.precision("base_price_list_rate"),
                )
            if item.rate:
                item.base_rate = flt(item.rate * conversion_rate, item.precision("base_rate"))
            if item.amount:
                item.base_amount = flt(item.amount * conversion_rate, item.precision("base_amount"))

        # Update payment amounts
        for payment in invoice_doc.payments:
            payment.base_amount = flt(payment.amount * conversion_rate, payment.precision("base_amount"))

        # Update invoice level amounts
        invoice_doc.base_total = flt(invoice_doc.total * conversion_rate, invoice_doc.precision("base_total"))
        invoice_doc.base_net_total = flt(
            invoice_doc.net_total * conversion_rate,
            invoice_doc.precision("base_net_total"),
        )
        invoice_doc.base_grand_total = flt(
            invoice_doc.grand_total * conversion_rate,
            invoice_doc.precision("base_grand_total"),
        )
        invoice_doc.base_rounded_total = flt(
            invoice_doc.rounded_total * conversion_rate,
            invoice_doc.precision("base_rounded_total"),
        )
        invoice_doc.base_in_words = money_in_words(invoice_doc.base_rounded_total, company_currency)

        # Update data to be sent back to frontend
        data["conversion_rate"] = conversion_rate
        data["plc_conversion_rate"] = plc_conversion_rate
        data["exchange_rate_date"] = exchange_rate_date

    inclusive = frappe.get_cached_value("POS Profile", invoice_doc.pos_profile, "posa_tax_inclusive")
    if invoice_doc.get("taxes"):
        for tax in invoice_doc.taxes:
            if tax.charge_type == "Actual":
                tax.included_in_print_rate = 0
            else:
                tax.included_in_print_rate = 1 if inclusive else 0

    # For return invoices, payments should be negative amounts
    if invoice_doc.is_return:
        for payment in invoice_doc.payments:
            payment.amount = -abs(payment.amount)
            payment.base_amount = -abs(payment.base_amount)

        invoice_doc.paid_amount = flt(sum(p.amount for p in invoice_doc.payments))
        invoice_doc.base_paid_amount = flt(sum(p.base_amount for p in invoice_doc.payments))

    invoice_doc.flags.ignore_permissions = True
    frappe.flags.ignore_account_permission = True
    invoice_doc.docstatus = 0
    invoice_doc.save()

    # Return both the invoice doc and the updated data
    response = invoice_doc.as_dict()
    response["conversion_rate"] = invoice_doc.conversion_rate
    response["plc_conversion_rate"] = invoice_doc.plc_conversion_rate
    response["exchange_rate_date"] = exchange_rate_date
    return response


@frappe.whitelist()
def submit_invoice(invoice, data):
    data = json.loads(data)
    invoice = json.loads(invoice)
    pos_profile = invoice.get("pos_profile")
    doctype = "Sales Invoice"
    if pos_profile and frappe.db.get_value(
        "POS Profile", pos_profile, "create_pos_invoice_instead_of_sales_invoice"
    ):
        doctype = "POS Invoice"

    invoice_name = invoice.get("name")
    
    # CRITICAL: Validate customer consistency before processing
    frontend_customer = invoice.get("customer")
    if not frontend_customer:
        frappe.throw(_("Customer is required for invoice submission"))
    
    if not invoice_name or not frappe.db.exists(doctype, invoice_name):
        created = update_invoice(json.dumps(invoice))
        invoice_name = created.get("name")
        invoice_doc = frappe.get_doc(doctype, invoice_name)
    else:
        invoice_doc = frappe.get_doc(doctype, invoice_name)
        
        # CRITICAL FIX: Validate customer matches before updating
        db_customer = invoice_doc.customer
        if db_customer != frontend_customer:
            frappe.log_error(
                f"Customer mismatch detected for invoice {invoice_name}. "
                f"Database customer: {db_customer}, Frontend customer: {frontend_customer}. "
                f"Using database customer to prevent data corruption.",
                "POS Customer Mismatch Warning"
            )
            # Use database customer, not frontend customer
            invoice["customer"] = db_customer
            invoice["customer_name"] = invoice_doc.customer_name
            invoice["title"] = invoice_doc.title or invoice_doc.customer_name
        
        invoice_without_advances = invoice.copy()
        invoice_without_advances.pop("advances", None)
        
        # Ensure customer fields are consistent before update
        invoice_without_advances["customer"] = db_customer
        if invoice_doc.customer_name:
            invoice_without_advances["customer_name"] = invoice_doc.customer_name
        if invoice_doc.title:
            invoice_without_advances["title"] = invoice_doc.title
        
        invoice_doc.update(invoice_without_advances)
        invoice_doc.set("advances", [])
        
        if invoice.get("payments") and isinstance(invoice.get("payments"), list):
            invoice_doc.set("payments", [])
            for payment in invoice.get("payments"):
                payment_row = invoice_doc.append("payments", {})
                payment_row.update(payment)
    
    # Set custom_return_reason for return invoices if not already set
    if invoice_doc.is_return and not invoice_doc.get("custom_return_reason"):
        # For Sales Invoice returns, return reason is mandatory
        if doctype == "Sales Invoice":
            frappe.throw(_("Return reason is mandatory for Sales Invoice returns. Please provide a return reason."))
        # For POS Invoice, use default from settings
        invoice_doc.custom_return_reason = get_default_return_reason()
    
    # Handle advance paid from sales order
    if invoice.get("sales_order"):
        sales_order_name = invoice.get("sales_order")
        invoice_doc.sales_order = sales_order_name
        
        if invoice_doc.doctype == "Sales Invoice":
            invoice_doc.set("advances", [])
            invoice_doc.calculate_taxes_and_totals()
            
            grand_total = flt(invoice_doc.grand_total or invoice_doc.rounded_total or 0)
            write_off = flt(invoice_doc.write_off_amount or 0)
            
            if invoice_doc.party_account_currency == invoice_doc.currency:
                invoice_total = flt(grand_total - write_off)
            else:
                base_write_off = flt(write_off * invoice_doc.conversion_rate) if invoice_doc.conversion_rate else write_off
                invoice_total = flt(grand_total * invoice_doc.conversion_rate - base_write_off) if invoice_doc.conversion_rate else grand_total
            
            advance_ref = frappe.get_all(
                "Payment Entry Reference",
                filters={
                    "reference_doctype": "Sales Order",
                    "reference_name": sales_order_name,
                },
                fields=["parent", "allocated_amount", "name"],
                limit=1,
            )
            
            if advance_ref:
                advance_ref = advance_ref[0]
                advance = frappe.get_doc("Payment Entry", advance_ref.parent)
                
                if advance.docstatus == 1:
                    allocated_amount_so = flt(advance_ref.allocated_amount)
                    allocated_amount = min(allocated_amount_so, invoice_total) if invoice_total > 0 else 0
                    
                    if allocated_amount > 0:
                        advance_payment = {
                            "reference_type": "Payment Entry",
                            "reference_name": advance.name,
                            "reference_row": advance_ref.name,
                            "remarks": advance.remarks or "",
                            "advance_amount": allocated_amount_so,
                            "allocated_amount": allocated_amount,
                        }
                        
                        advance_row = invoice_doc.append("advances", {})
                        advance_row.update(advance_payment)
                        
                        if advance.source_exchange_rate:
                            advance_row.ref_exchange_rate = advance.source_exchange_rate
                        
                        child_dt = (
                            "POS Invoice Advance" if invoice_doc.doctype == "POS Invoice" 
                            else "Sales Invoice Advance"
                        )
                        ensure_child_doctype(invoice_doc, "advances", child_dt)
                        invoice_doc.is_pos = 0
                        invoice_doc.calculate_taxes_and_totals()

    # Ensure item name overrides are respected on submit
    _apply_item_name_overrides(invoice_doc)
    if invoice.get("posa_delivery_date"):
        invoice_doc.update_stock = 0
    mop_cash_list = [
        i.mode_of_payment
        for i in invoice_doc.payments
        if "cash" in i.mode_of_payment.lower() and i.type == "Cash"
    ]
    if len(mop_cash_list) > 0:
        cash_account = get_bank_cash_account(mop_cash_list[0], invoice_doc.company)
    else:
        cash_account = {"account": frappe.get_value("Company", invoice_doc.company, "default_cash_account")}

    # Update remarks with items details
    items = []
    for item in invoice_doc.items:
        if item.item_name and item.rate and item.qty:
            total = item.rate * item.qty
            items.append(f"{item.item_name} - Rate: {item.rate}, Qty: {item.qty}, Amount: {total}")

    # Add the grand total at the end of remarks
    grand_total = f"\nGrand Total: {invoice_doc.grand_total}"
    items.append(grand_total)

    invoice_doc.remarks = "\n".join(items)

    # creating advance payment
    if data.get("credit_change"):
        cash_mode_of_payment = None
        for payment in invoice_doc.payments:
            if payment.get("type") == "Cash" and payment.get("mode_of_payment"):
                cash_mode_of_payment = payment.get("mode_of_payment")
                break

        if not cash_mode_of_payment and pos_profile:
            cash_mode_of_payment = (
                frappe.db.get_value("POS Profile", pos_profile, "posa_cash_mode_of_payment")
                or "Cash"
            )

        posting_date = invoice_doc.get("posting_date") or nowdate()
        reference_no = invoice_doc.get("posa_pos_opening_shift")
        advance_payment_entry = frappe.get_doc(
            {
                "doctype": "Payment Entry",
                "mode_of_payment": cash_mode_of_payment or "Cash",
                "paid_to": cash_account["account"],
                "payment_type": "Receive",
                "party_type": "Customer",
                "party": invoice_doc.get("customer"),
                "paid_amount": invoice_doc.get("credit_change"),
                "received_amount": invoice_doc.get("credit_change"),
                "company": invoice_doc.get("company"),
                "posting_date": posting_date,
            }
        )

        if reference_no:
            advance_payment_entry.reference_no = reference_no
            advance_payment_entry.reference_date = posting_date

        advance_payment_entry.flags.ignore_permissions = True
        frappe.flags.ignore_account_permission = True
        advance_payment_entry.save()
        advance_payment_entry.submit()

    # calculating cash
    total_cash = 0
    if data.get("redeemed_customer_credit"):
        total_cash = invoice_doc.total - float(data.get("redeemed_customer_credit"))

    is_payment_entry = 0
    if data.get("redeemed_customer_credit"):
        for row in data.get("customer_credit_dict"):
            if row["type"] == "Advance" and row["credit_to_redeem"]:
                advance = frappe.get_doc("Payment Entry", row["credit_origin"])

                advance_payment = {
                    "reference_type": "Payment Entry",
                    "reference_name": advance.name,
                    "remarks": advance.remarks,
                    "advance_amount": advance.unallocated_amount,
                    "allocated_amount": row["credit_to_redeem"],
                }

                advance_row = invoice_doc.append("advances", {})
                advance_row.update(advance_payment)
                child_dt = (
                    "POS Invoice Advance" if invoice_doc.doctype == "POS Invoice" else "Sales Invoice Advance"
                )
                ensure_child_doctype(invoice_doc, "advances", child_dt)
                invoice_doc.is_pos = 0
                is_payment_entry = 1

    payments = invoice_doc.payments

    _auto_set_return_batches(invoice_doc)

    # if frappe.get_value("POS Profile", invoice_doc.pos_profile, "posa_auto_set_batch"):
    #     set_batch_nos(invoice_doc, "warehouse", throw=True)
    if cint(getattr(invoice_doc, "update_stock", 0)):
        set_batch_nos_for_bundels(invoice_doc, "warehouse", throw=True)

    _validate_stock_on_invoice(invoice_doc)

    # Save custom_customer_number from data if provided
    if data.get("custom_customer_number"):
        invoice_doc.custom_customer_number = data.get("custom_customer_number")

    # Final validation: Ensure customer is consistent
    if invoice_doc.customer != frontend_customer and invoice_doc.customer:
        # Database customer takes precedence if mismatch
        frappe.log_error(
            f"Final customer validation: Using database customer {invoice_doc.customer} "
            f"instead of frontend customer {frontend_customer} for invoice {invoice_name}",
            "POS Customer Final Check"
        )
    
    # Ensure title matches customer_name
    if invoice_doc.customer_name and invoice_doc.title != invoice_doc.customer_name:
        invoice_doc.title = invoice_doc.customer_name
    elif not invoice_doc.title and invoice_doc.customer_name:
        invoice_doc.title = invoice_doc.customer_name
    elif not invoice_doc.title:
        invoice_doc.title = invoice_doc.customer or invoice_doc.customer_name

    invoice_doc.flags.ignore_permissions = True
    frappe.flags.ignore_account_permission = True
    invoice_doc.posa_is_printed = 1
    invoice_doc.save()

    if invoice_doc.docstatus == 0:
        _validate_billing_only_dn_daily_quota_before_submit(invoice_doc)

    payment_entry_data = None
    if invoice_doc.doctype == "Sales Invoice" and hasattr(invoice_doc, 'sales_order') and invoice_doc.sales_order:
        invoice_doc.calculate_taxes_and_totals()
        outstanding = flt(invoice_doc.outstanding_amount or 0)
        payments_from_frontend = invoice.get("payments", [])
        
        if payments_from_frontend and outstanding > 0:
            total_payment = sum(flt(p.get("amount", 0)) for p in payments_from_frontend)
            
            if total_payment > 0:
                first_payment = payments_from_frontend[0]
                mode_of_payment = first_payment.get("mode_of_payment") or "Cash"
                
                try:
                    payment_account = get_bank_cash_account(mode_of_payment, invoice_doc.company)
                    paid_to_account = payment_account.get("account")
                except:
                    paid_to_account = frappe.get_value("Company", invoice_doc.company, "default_cash_account")
                
                payment_entry_data = {
                    "mode_of_payment": mode_of_payment,
                    "paid_to_account": paid_to_account,
                    "total_payment": total_payment,
                    "outstanding": outstanding,
                }

    if data.get("due_date"):
        frappe.db.set_value(
            invoice_doc.doctype,
            invoice_doc.name,
            "due_date",
            data.get("due_date"),
            update_modified=False,
        )

    if frappe.get_value(
        "POS Profile",
        invoice_doc.pos_profile,
        "posa_allow_submissions_in_background_job",
    ):
        invoices_list = frappe.get_all(
            invoice_doc.doctype,
            filters={
                "posa_pos_opening_shift": invoice_doc.posa_pos_opening_shift,
                "docstatus": 0,
                "posa_is_printed": 1,
            },
        )
        for invoice in invoices_list:
            enqueue(
                method=submit_in_background_job,
                queue="short",
                timeout=1000,
                is_async=True,
                kwargs={
                    "invoice": invoice.name,
                    "doctype": invoice_doc.doctype,
                    "invoice_doc": invoice_doc,
                    "data": data,
                    "is_payment_entry": is_payment_entry,
                    "total_cash": total_cash,
                    "cash_account": cash_account,
                    "payments": payments,
                },
            )
    else:
        invoice_doc.submit()
        
        if payment_entry_data and invoice_doc.doctype == "Sales Invoice":
            posting_date = invoice_doc.get("posting_date") or nowdate()
            
            # Use OUTSTANDING amount, not total_payment
            # This ensures we only create Payment Entry for the balance
            # If customer pays 100 cash and outstanding is 50, only record 50
            # The 50 change is returned to customer (not recorded)
            amount_to_record = min(
                flt(payment_entry_data["total_payment"]), 
                flt(payment_entry_data["outstanding"])
            )
            
            payment_entry = frappe.get_doc({
                "doctype": "Payment Entry",
                "mode_of_payment": payment_entry_data["mode_of_payment"],
                "paid_to": payment_entry_data["paid_to_account"],
                "payment_type": "Receive",
                "party_type": "Customer",
                "party": invoice_doc.customer,
                "paid_amount": amount_to_record,
                "received_amount": amount_to_record,
                "company": invoice_doc.company,
                "posting_date": posting_date,
            })
            
            payment_entry.append("references", {
                "reference_doctype": "Sales Invoice",
                "reference_name": invoice_doc.name,
                "allocated_amount": amount_to_record,
            })
            
            if invoice_doc.get("posa_pos_opening_shift"):
                payment_entry.reference_no = invoice_doc.posa_pos_opening_shift
                payment_entry.reference_date = posting_date
            
            payment_entry.flags.ignore_permissions = True
            frappe.flags.ignore_account_permission = True
            payment_entry.save()
            payment_entry.submit()
        
        redeeming_customer_credit(invoice_doc, data, is_payment_entry, total_cash, cash_account, payments)

    return {"name": invoice_doc.name, "status": invoice_doc.docstatus}


def submit_in_background_job(kwargs):
    invoice = kwargs.get("invoice")
    doctype = kwargs.get("doctype") or "Sales Invoice"
    data = kwargs.get("data")
    is_payment_entry = kwargs.get("is_payment_entry")
    total_cash = kwargs.get("total_cash")
    cash_account = kwargs.get("cash_account")
    payments = kwargs.get("payments")

    invoice_doc = frappe.get_doc(doctype, invoice)

    # Update remarks with items details for background job
    items = []
    for item in invoice_doc.items:
        if item.item_name and item.rate and item.qty:
            total = item.rate * item.qty
            items.append(f"{item.item_name} - Rate: {item.rate}, Qty: {item.qty}, Amount: {total}")

    # Add the grand total at the end of remarks
    grand_total = f"\nGrand Total: {invoice_doc.grand_total}"
    items.append(grand_total)

    invoice_doc.remarks = "\n".join(items)
    invoice_doc.save()

    if invoice_doc.docstatus == 0:
        _validate_billing_only_dn_daily_quota_before_submit(invoice_doc)

    invoice_doc.submit()
    redeeming_customer_credit(invoice_doc, data, is_payment_entry, total_cash, cash_account, payments)


@frappe.whitelist()
def delete_invoice(invoice):
    doctype = "Sales Invoice"
    if frappe.db.exists("POS Invoice", invoice):
        doctype = "POS Invoice"
    elif not frappe.db.exists("Sales Invoice", invoice):
        frappe.throw(_("Invoice {0} does not exist").format(invoice))

    if frappe.db.has_column(doctype, "posa_is_printed") and frappe.get_value(
        doctype, invoice, "posa_is_printed"
    ):
        frappe.throw(_("This invoice {0} cannot be deleted").format(invoice))

    frappe.delete_doc(doctype, invoice, force=1)
    return _("Invoice {0} Deleted").format(invoice)


@frappe.whitelist()
def get_draft_invoices(pos_opening_shift, doctype="Sales Invoice"):
    filters = {
        "posa_pos_opening_shift": pos_opening_shift,
        "docstatus": 0,
    }
    if frappe.db.has_column(doctype, "posa_is_printed"):
        filters["posa_is_printed"] = 0

    invoices_list = frappe.get_list(
        doctype,
        filters=filters,
        fields=["name"],
        limit_page_length=0,
        order_by="modified desc",
    )
    data = []
    for invoice in invoices_list:
        data.append(frappe.get_cached_doc(doctype, invoice["name"]))
    return data


@frappe.whitelist()
def search_invoices_for_return(
    invoice_name,
    company,
    customer_name=None,
    customer_id=None,
    mobile_no=None,
    tax_id=None,
    from_date=None,
    to_date=None,
    min_amount=None,
    max_amount=None,
    page=1,
    doctype="Sales Invoice",
):
    """
    Search for invoices that can be returned with separate customer search fields and pagination

    Args:
        invoice_name: Invoice ID to search for
        company: Company to search in
        customer_name: Customer name to search for
        customer_id: Customer ID to search for
        mobile_no: Mobile number to search for
        tax_id: Tax ID to search for
        from_date: Start date for filtering
        to_date: End date for filtering
        min_amount: Minimum invoice amount to filter by
        max_amount: Maximum invoice amount to filter by
        page: Page number for pagination (starts from 1)

    Returns:
        Dictionary with:
        - invoices: List of invoice documents
        - has_more: Boolean indicating if there are more invoices to load
    """
    try:
        # Start with base filters
        filters = {
            "company": company,
            "docstatus": 1,
            "is_return": 0,
        }

        # Convert page to integer if it's a string
        if page and isinstance(page, str):
            page = int(page)
        else:
            page = 1  # Default to page 1

        # Items per page - can be adjusted based on performance requirements
        page_length = 100
        start = (page - 1) * page_length

        # Add invoice name filter if provided
        if invoice_name:
            filters["name"] = ["like", f"%{invoice_name}%"]

        # Add date range filters if provided
        if from_date:
            filters["posting_date"] = [">=", from_date]

        if to_date:
            if "posting_date" in filters:
                filters["posting_date"] = ["between", [from_date, to_date]]
            else:
                filters["posting_date"] = ["<=", to_date]

        # Add amount filters if provided
        if min_amount:
            filters["grand_total"] = [">=", float(min_amount)]

        if max_amount:
            if "grand_total" in filters:
                # If min_amount was already set, change to between
                filters["grand_total"] = ["between", [float(min_amount), float(max_amount)]]
            else:
                filters["grand_total"] = ["<=", float(max_amount)]

        # If any customer search criteria is provided, find matching customers
        customer_ids = []
        if customer_name or customer_id or mobile_no or tax_id:
            conditions = []
            params = {}

            if customer_name:
                conditions.append("customer_name LIKE %(customer_name)s")
                params["customer_name"] = f"%{customer_name}%"

            if customer_id:
                conditions.append("name LIKE %(customer_id)s")
                params["customer_id"] = f"%{customer_id}%"

            if mobile_no:
                conditions.append("mobile_no LIKE %(mobile_no)s")
                params["mobile_no"] = f"%{mobile_no}%"

            if tax_id:
                conditions.append("tax_id LIKE %(tax_id)s")
                params["tax_id"] = f"%{tax_id}%"

            # Build the WHERE clause for the query
            where_clause = " OR ".join(conditions)
            customer_query = f"""
            SELECT name
            FROM `tabCustomer`
            WHERE {where_clause}
            LIMIT 100
        """

            customers = frappe.db.sql(customer_query, params, as_dict=True)
            customer_ids = [c.name for c in customers]

            # If we found matching customers, add them to the filter
            if customer_ids:
                filters["customer"] = ["in", customer_ids]
            # If customer search criteria provided but no matches found, return empty
            elif any([customer_name, customer_id, mobile_no, tax_id]):
                return {"invoices": [], "has_more": False}

        # Count total invoices matching the criteria (for has_more flag)
        total_count_query = frappe.get_list(
            doctype,
            filters=filters,
            fields=["count(name) as total_count"],
            as_list=False,
        )
        total_count = total_count_query[0].total_count if total_count_query else 0

        # Get invoices matching all criteria with pagination
        invoices_list = frappe.get_list(
            doctype,
            filters=filters,
            fields=["name"],
            limit_start=start,
            limit_page_length=page_length,
            order_by="posting_date desc, name desc",
        )

        # Process and return the results
        data = []

        # Process invoices and check for returns
        for invoice in invoices_list:
            invoice_doc = frappe.get_doc(doctype, invoice.name)

            # Check if any items have already been returned
            has_returns = frappe.get_all(
                doctype,
                filters={"return_against": invoice.name, "docstatus": 1},
                fields=["name"],
            )

            filtered_items = None
            if has_returns:
                # Calculate returned quantity per item_code
                returned_qty = {}
                for ret_inv in has_returns:
                    ret_doc = frappe.get_doc(doctype, ret_inv.name)
                    for item in ret_doc.items:
                        returned_qty[item.item_code] = returned_qty.get(item.item_code, 0) + abs(item.qty)

                # Filter items with remaining qty
                filtered_items = []
                for item in invoice_doc.items:
                    remaining_qty = item.qty - returned_qty.get(item.item_code, 0)
                    if remaining_qty > 0:
                        new_item = item.as_dict().copy()
                        new_item["qty"] = remaining_qty
                        new_item["amount"] = remaining_qty * item.rate
                        if item.get("stock_qty"):
                            new_item["stock_qty"] = (
                                item.stock_qty / item.qty * remaining_qty if item.qty else remaining_qty
                            )
                        filtered_items.append(new_item)

            if filtered_items:
                # Create a copy of invoice dict with filtered items
                invoice_dict = frappe.get_doc(doctype, invoice.name).as_dict()
                # Replace items with filtered items (already dictionaries)
                invoice_dict["items"] = filtered_items
                data.append(invoice_dict)
            else:
                # Convert to dict for JSON serialization
                data.append(invoice_doc.as_dict())

        # Check if there are more results
        has_more = (start + page_length) < total_count

        return {"invoices": data, "has_more": has_more}
    except Exception as e:
        frappe.log_error(f"Error in search_invoices_for_return: {str(e)}", "Search Invoices Error")
        frappe.throw(_("Error searching invoices: {0}").format(str(e)))


@frappe.whitelist()
def create_sales_invoice_from_order(sales_order):
    sales_invoice = make_sales_invoice(sales_order, ignore_permissions=True)
    sales_invoice.save()
    return sales_invoice


@frappe.whitelist()
def delete_sales_invoice(sales_invoice):
    frappe.delete_doc("Sales Invoice", sales_invoice)


@frappe.whitelist()
def get_sales_invoice_child_table(sales_invoice, sales_invoice_item):
    parent_doc = frappe.get_doc("Sales Invoice", sales_invoice)
    child_doc = frappe.get_doc("Sales Invoice Item", {"parent": parent_doc.name, "name": sales_invoice_item})
    return child_doc


@frappe.whitelist()
def update_invoice_from_order(data):
    data = json.loads(data)
    invoice_doc = frappe.get_doc("Sales Invoice", data.get("name"))
    invoice_doc.update(data)
    invoice_doc.save()
    return invoice_doc


@frappe.whitelist()
def get_available_currencies():
    """Get list of available currencies from ERPNext"""
    return frappe.get_all(
        "Currency",
        fields=["name", "currency_name"],
        filters={"enabled": 1},
        order_by="currency_name",
    )


@frappe.whitelist()
def fetch_exchange_rate(currency: str, company: str, posting_date: str | None = None):
    """Return latest exchange rate and its date."""
    company_currency = frappe.get_cached_value("Company", company, "default_currency")
    rate, date = get_latest_rate(currency, company_currency)
    return {"exchange_rate": rate, "date": date}


@frappe.whitelist()
def fetch_exchange_rate_pair(from_currency: str, to_currency: str, posting_date: str | None = None):
    """Return latest exchange rate between two currencies along with rate date."""
    rate, date = get_latest_rate(from_currency, to_currency)
    return {"exchange_rate": rate, "date": date}


@frappe.whitelist()
def get_price_list_currency(price_list: str) -> str:
    """Return the currency of the given Price List."""
    if not price_list:
        return None
    return frappe.db.get_value("Price List", price_list, "currency")

@frappe.whitelist()
def get_sales_invoice_list(page=1, items_per_page=25, filters=None, pos_profile=None):
    """
    Paginated invoice list with optional filters.
    Supports both POS Invoice and Sales Invoice — automatically switches based on POS Profile.
    Handles status filtering for both types and flexible pagination.
    """
    # Parse filters
    if isinstance(filters, str):
        try:
            filters = json.loads(filters)
        except Exception:
            filters = {}
    elif not filters:
        filters = {}

    # Pagination safety
    try:
        page = cint(page)
        if page <= 0:
            page = 1
    except Exception:
        page = 1

    try:
        items_per_page = cint(items_per_page)
        if items_per_page <= 0:
            items_per_page = 25
    except Exception:
        items_per_page = 25

    start = (page - 1) * items_per_page

    # Determine which doctype to use
    use_pos_invoice = False
    if pos_profile:
        use_pos_invoice = frappe.db.get_value(
            "POS Profile",
            pos_profile,
            "create_pos_invoice_instead_of_sales_invoice"
        )

    table_name = "tabPOS Invoice" if use_pos_invoice else "tabSales Invoice"
    doctype_name = "POS Invoice" if use_pos_invoice else "Sales Invoice"

    # Fallback logic if POS Invoice table empty
    if use_pos_invoice and pos_profile:
        pos_count = frappe.db.count("POS Invoice", filters={"pos_profile": pos_profile})
        if not pos_count:
            table_name = "tabSales Invoice"
            doctype_name = "Sales Invoice"
            use_pos_invoice = False

    # Build SQL conditions
    conditions = "1=1"
    values = {}
    
    # Only show submitted invoices (docstatus = 1)
    conditions += " AND si.docstatus = 1"

    if filters.get("invoice_name"):
        conditions += " AND si.name LIKE %(invoice_name)s"
        values["invoice_name"] = f"%{filters['invoice_name']}%"

    if filters.get("customer_name"):
        conditions += " AND si.customer_name LIKE %(customer_name)s"
        values["customer_name"] = f"%{filters['customer_name']}%"

    if filters.get("customer"):
        conditions += " AND si.customer = %(customer)s"
        values["customer"] = cstr(filters["customer"]).strip()

    if cint(filters.get("for_delivery_note")):
        # Billing-only POS invoices (update stock off) with quantity still to deliver
        conditions += " AND IFNULL(si.update_stock, 0) = 0"
        conditions += " AND IFNULL(si.is_return, 0) = 0"
        item_table = "`tabPOS Invoice Item`" if use_pos_invoice else "`tabSales Invoice Item`"
        conditions += f"""
            AND EXISTS (
                SELECT 1 FROM {item_table} sii
                WHERE sii.parent = si.name
                AND sii.parenttype = %(dn_item_parenttype)s
                AND IFNULL(sii.delivered_by_supplier, 0) = 0
                AND (sii.qty - IFNULL(sii.delivered_qty, 0)) > 0.0000001
            )
        """
        values["dn_item_parenttype"] = doctype_name

    if filters.get("from_date"):
        conditions += " AND si.posting_date >= %(from_date)s"
        values["from_date"] = filters["from_date"]

    if filters.get("to_date"):
        conditions += " AND si.posting_date <= %(to_date)s"
        values["to_date"] = filters["to_date"]

    # Always filter by POS profile if provided (mandatory for POS invoices)
    if pos_profile:
        conditions += " AND si.pos_profile = %(pos_profile)s"
        values["pos_profile"] = pos_profile
    
    # Filter by is_pos if provided in filters
    if filters.get("is_pos") is not None:
        conditions += " AND si.is_pos = %(is_pos)s"
        values["is_pos"] = filters.get("is_pos")

    #  Unified Status Handling
    if filters.get("status") not in (None, ""):
        status = filters.get("status").lower()

        if use_pos_invoice:
            # Map textual statuses to docstatus or outstanding conditions
            if status == "draft":
                conditions += " AND si.docstatus = 0"
            elif status in ("paid", "consolidated"):
                conditions += " AND si.docstatus = 1"
                # further refine if needed:
                # conditions += " AND si.outstanding_amount = 0"
            elif status == "cancelled":
                conditions += " AND si.docstatus = 2"
        else:
            conditions += " AND si.status = %(status)s"
            values["status"] = filters["status"]

    # Total count
    total_row = frappe.db.sql(
        f"SELECT COUNT(*) AS total FROM `{table_name}` si WHERE {conditions}",
        values,
        as_dict=True,
    )
    total_count = total_row[0].total if total_row else 0

    # Fetch invoices
    invoices = frappe.db.sql(
        f"""
        SELECT
            si.name,
            si.customer,
            si.customer_name,
            si.posting_date,
            si.grand_total,
            si.net_total,
            si.total_taxes_and_charges,
            si.currency,
            si.docstatus,
            si.is_return,
            si.status,
            si.outstanding_amount,
            si.paid_amount,
            si.pos_profile,
            si.update_stock,
            '{doctype_name}' AS doctype
        FROM `{table_name}` si
        WHERE {conditions}
        ORDER BY si.posting_date DESC, si.name DESC
        LIMIT {items_per_page} OFFSET {start}
        """,
        values,
        as_dict=True,
    )

    #  Attach items with numeric coercion
    item_doctype = "POS Invoice Item" if use_pos_invoice else "Sales Invoice Item"

    for inv in invoices:
        items = frappe.get_all(
            item_doctype,
            filters={
                "parent": inv.get("name"),
                "parenttype": doctype_name,
                "parentfield": "items",
            },
            fields=["item_code", "item_name", "qty", "rate", "amount", "uom"],
            limit_page_length=100,
        )

        for it in items:
            it["qty"] = flt(it.get("qty") or 0)
            it["rate"] = flt(it.get("rate") or 0)
            it["amount"] = flt(it.get("amount") or 0)

        inv["items"] = items

    # Pagination summary
    has_more = (start + items_per_page) < total_count
    total_pages = (total_count + items_per_page - 1) // items_per_page

    return {
        "invoices": invoices,
        "pagination": {
            "current_page": page,
            "total_pages": total_pages,
            "total_count": total_count,
            "items_per_page": items_per_page,
            "has_more": has_more,
        },
    }


@frappe.whitelist()
def get_invoice_delivery_preview(invoice_name, pos_profile=None):
    """
    Lines to deliver with warehouse and available stock (before creating a Delivery Note).
    """
    invoice_name = cstr(invoice_name or "").strip()
    if not invoice_name:
        frappe.throw(_("Invoice is required"))

    pos_profile = cstr(pos_profile or "").strip() or None

    doctype = None
    if frappe.db.exists("POS Invoice", invoice_name):
        doctype = "POS Invoice"
    elif frappe.db.exists("Sales Invoice", invoice_name):
        doctype = "Sales Invoice"
    else:
        frappe.throw(_("Invoice {0} not found").format(frappe.bold(invoice_name)))

    doc = frappe.get_doc(doctype, invoice_name)
    doc.check_permission("read")

    if pos_profile and doc.get("pos_profile") and doc.get("pos_profile") != pos_profile:
        frappe.throw(_("This invoice does not belong to the active POS Profile"))

    set_wh = doc.get("set_warehouse") or ""
    lines = []

    for row in doc.get("items") or []:
        if getattr(row, "delivered_by_supplier", 0):
            continue
        qty_to_deliver = flt(row.qty) - flt(row.delivered_qty or 0)
        if qty_to_deliver <= 0:
            continue

        wh = row.warehouse or set_wh or ""
        is_stock = cint(frappe.db.get_value("Item", row.item_code, "is_stock_item") or 0)
        stock_in_wh = None
        if is_stock:
            if getattr(row, "batch_no", None) and wh:
                stock_in_wh = flt(get_batch_qty(row.batch_no, wh) or 0)
            elif wh:
                stock_in_wh = flt(get_stock_availability(row.item_code, wh))
            else:
                stock_in_wh = 0.0

        lines.append(
            {
                "item_code": row.item_code or "",
                "item_name": row.item_name or "",
                "warehouse": wh,
                "uom": row.uom or "",
                "invoice_qty": flt(row.qty),
                "delivered_qty": flt(row.delivered_qty or 0),
                "qty_to_deliver": qty_to_deliver,
                "stock_in_warehouse": stock_in_wh,
                "is_stock_item": is_stock,
                "batch_no": getattr(row, "batch_no", None) or "",
            }
        )

    return {
        "invoice_name": doc.name,
        "doctype": doctype,
        "customer_name": doc.customer_name or "",
        "set_warehouse": set_wh,
        "lines": lines,
    }


def _serialize_delivery_note_summary(dn_name: str) -> dict:
    """Return display-safe totals and lines for POS UI (no desk redirect)."""
    dn = frappe.get_doc("Delivery Note", dn_name)
    dn.check_permission("read")
    items = []
    for row in dn.items:
        items.append(
            {
                "item_code": row.item_code or "",
                "item_name": row.item_name or "",
                "qty": flt(row.qty),
                "uom": row.uom or "",
                "rate": flt(row.rate),
                "amount": flt(row.amount),
            }
        )
    return {
        "name": dn.name,
        "doctype": dn.doctype,
        "docstatus": dn.docstatus,
        "customer": dn.customer,
        "customer_name": dn.customer_name or "",
        "posting_date": str(dn.posting_date) if dn.posting_date else None,
        "company": dn.company,
        "currency": dn.currency,
        "items": items,
        "net_total": flt(dn.net_total),
        "total_taxes_and_charges": flt(dn.total_taxes_and_charges),
        "grand_total": flt(dn.grand_total),
    }


def _make_delivery_note_from_pos_invoice(source_name, target_doc=None):
    """Map POS Invoice to Delivery Note (standard SI link fields are cleared before insert)."""
    from frappe.model.mapper import get_mapped_doc

    def set_missing_values(source, target):
        target.run_method("set_missing_values")
        target.run_method("set_po_nos")
        target.run_method("calculate_taxes_and_totals")

    def update_item(source_doc, target_doc, source_parent):
        target_doc.qty = flt(source_doc.qty) - flt(source_doc.delivered_qty)
        target_doc.stock_qty = target_doc.qty * flt(source_doc.conversion_factor)
        target_doc.base_amount = target_doc.qty * flt(source_doc.base_rate)
        target_doc.amount = target_doc.qty * flt(source_doc.rate)

    return get_mapped_doc(
        "POS Invoice",
        source_name,
        {
            "POS Invoice": {"doctype": "Delivery Note", "validation": {"docstatus": ["=", 1]}},
            "POS Invoice Item": {
                "doctype": "Delivery Note Item",
                "field_map": {
                    "name": "si_detail",
                    "parent": "against_sales_invoice",
                    "serial_no": "serial_no",
                    "sales_order": "against_sales_order",
                    "so_detail": "so_detail",
                    "cost_center": "cost_center",
                },
                "postprocess": update_item,
                "condition": lambda doc: doc.delivered_by_supplier != 1,
            },
            "Sales Taxes and Charges": {"doctype": "Sales Taxes and Charges", "reset_value": True},
            "Sales Team": {
                "doctype": "Sales Team",
                "field_map": {"incentives": "incentives"},
                "add_if_empty": True,
            },
        },
        target_doc,
        set_missing_values,
    )


@frappe.whitelist()
def create_delivery_note_from_invoice(invoice_name, pos_profile=None):
    """
    Create and submit a Delivery Note from a submitted billing-only POS/Sales invoice.
    Sales Invoice uses ERPNext's standard mapper; POS Invoice uses a POS-specific map
    and clears against_sales_invoice lines because that link only allows Sales Invoice.
    """
    from erpnext.accounts.doctype.sales_invoice.sales_invoice import make_delivery_note

    invoice_name = cstr(invoice_name or "").strip()
    if not invoice_name:
        frappe.throw(_("Invoice is required"))

    pos_profile = cstr(pos_profile or "").strip() or None

    doctype = None
    if frappe.db.exists("POS Invoice", invoice_name):
        doctype = "POS Invoice"
    elif frappe.db.exists("Sales Invoice", invoice_name):
        doctype = "Sales Invoice"
    else:
        frappe.throw(_("Invoice {0} not found").format(frappe.bold(invoice_name)))

    doc = frappe.get_doc(doctype, invoice_name)
    doc.check_permission("read")

    if pos_profile and doc.get("pos_profile") and doc.get("pos_profile") != pos_profile:
        frappe.throw(_("This invoice does not belong to the active POS Profile"))

    if doc.docstatus != 1:
        frappe.throw(_("Submit the invoice before creating a Delivery Note"))

    if doc.get("is_return"):
        frappe.throw(_("Delivery Note cannot be created from a return invoice here"))

    if cint(doc.get("update_stock")) != 0:
        frappe.throw(
            _(
                "This invoice already updates stock on submission. Use the Delivery Note list only for billing-only invoices (Update stock off)."
            )
        )

    if doctype == "Sales Invoice":
        dn = make_delivery_note(invoice_name)
        if not dn or not getattr(dn, "items", None):
            frappe.throw(_("Nothing left to deliver against this invoice"))
        dn.insert()
        dn.submit()
        return _serialize_delivery_note_summary(dn.name)

    dn = _make_delivery_note_from_pos_invoice(invoice_name)
    if not dn or not getattr(dn, "items", None):
        frappe.throw(_("Nothing left to deliver against this invoice"))

    for row in dn.items:
        row.against_sales_invoice = None
        row.si_detail = None

    dn.insert(ignore_links=True)
    dn.submit()
    return _serialize_delivery_note_summary(dn.name)