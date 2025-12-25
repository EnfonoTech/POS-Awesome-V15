# -*- coding: utf-8 -*-
# Copyright (c) 2025, Youssef Restom and contributors
# For license information, please see license.txt

from __future__ import unicode_literals
import json
import frappe
from frappe.utils import nowdate, flt, cstr
from frappe import _
from erpnext.selling.doctype.sales_order.sales_order import make_sales_invoice
from posawesome.posawesome.api.customers import create_customer
from posawesome.posawesome.api.payment_entry import create_payment_entry
from posawesome.posawesome.api.utilities import get_version


def _find_customer_by_phone(mobile_no):
    """Find customer by phone number."""
    if not mobile_no:
        return None
    
    # Clean phone number
    cleaned_number = mobile_no.strip().replace(" ", "").replace("-", "").replace("(", "").replace(")", "").replace("+", "")
    
    # Search in Customer table
    customers = frappe.db.sql("""
        SELECT name, customer_name, mobile_no
        FROM `tabCustomer`
        WHERE mobile_no LIKE %s
        AND disabled = 0
        ORDER BY modified DESC
        LIMIT 1
    """, f"%{cleaned_number}%", as_dict=True)
    
    if customers:
        return customers[0].name
    
    # Search in Contact table
    contacts = frappe.db.sql("""
        SELECT dl.link_name as customer
        FROM `tabContact` c
        INNER JOIN `tabDynamic Link` dl ON dl.parent = c.name
        WHERE dl.link_doctype = 'Customer'
        AND (c.mobile_no LIKE %s OR c.phone LIKE %s)
        ORDER BY c.modified DESC
        LIMIT 1
    """, (f"%{cleaned_number}%", f"%{cleaned_number}%"), as_dict=True)
    
    if contacts:
        return contacts[0].customer
    
    return None


def _create_item_if_not_exists(item_name, settings, company):
    """Create item if it doesn't exist with default settings."""
    if not item_name or not item_name.strip():
        frappe.throw(_("Item name cannot be empty"))
    
    item_name = item_name.strip()
    
    # First check if item exists by item_code (using item_name as potential code)
    existing_item_by_code = frappe.db.get_value("Item", item_name, "name")
    if existing_item_by_code:
        return existing_item_by_code
    
    # Check if item exists by item_name
    existing_item_by_name = frappe.db.get_value("Item", {"item_name": item_name}, "name")
    if existing_item_by_name:
        return existing_item_by_name
    
    # Get defaults from settings
    item_group = settings.get("default_item_group") or "All Item Groups"
    uom = settings.get("default_uom") or "Nos"
    
    # Generate unique item_code if item_name would conflict
    # Clean item_code to be valid (remove special chars, limit length)
    import re
    item_code = re.sub(r'[^\w\s-]', '', item_name)[:140]  # Limit to 140 chars for item_code
    item_code = item_code.strip().replace(" ", "-")  # Replace spaces with hyphens
    
    # If item_code is empty after cleaning, use a default
    if not item_code:
        item_code = "ITEM"
    
    # Check if this code exists and generate unique one
    counter = 1
    original_code = item_code
    while frappe.db.exists("Item", item_code):
        item_code = f"{original_code}-{counter}"
        counter += 1
        if counter > 1000:  # Safety limit
            frappe.throw(_("Unable to generate unique item code for: {0}").format(item_name))
    
    # Create new item
    item = frappe.get_doc({
        "doctype": "Item",
        "item_code": item_code,
        "item_name": item_name,
        "item_group": item_group,
        "stock_uom": uom,
        "is_stock_item": 0,
    })
    
    item.flags.ignore_permissions = True
    item.insert()
    
    return item.name


@frappe.whitelist()
def create_minimal_sales_order(data):
    """Create sales order with minimal details."""
    data = json.loads(data) if isinstance(data, str) else data
    
    # Get settings
    settings = frappe.get_cached_doc("Fateh POS Settings", "Fateh POS Settings")
    if not settings.get("enable_minimal_sales_order"):
        frappe.throw(_("Minimal Sales Order feature is not enabled"))
    
    # Get customer
    customer_name = data.get("customer_name")
    mobile_no = data.get("mobile_no") or data.get("customer_number")
    
    if not customer_name:
        frappe.throw(_("Customer name is required"))
    
    # Find or create customer
    customer = None
    if mobile_no:
        customer = _find_customer_by_phone(mobile_no)
    
    if not customer:
        # Create customer
        pos_profile_doc = json.dumps({
            "posa_allow_duplicate_customer_names": 1
        })
        
        customer_doc = create_customer(
            customer_name=customer_name,
            company=data.get("company"),
            pos_profile_doc=pos_profile_doc,
            mobile_no=mobile_no,
            method="create"
        )
        customer = customer_doc.name
    else:
        # Update customer name if different
        existing_name = frappe.db.get_value("Customer", customer, "customer_name")
        if existing_name != customer_name:
            frappe.db.set_value("Customer", customer, "customer_name", customer_name)
    
    # Get POS Profile for defaults
    pos_profile = data.get("pos_profile")
    if not pos_profile:
        frappe.throw(_("POS Profile is required"))
    
    pos_profile_doc = frappe.get_doc("POS Profile", pos_profile)
    company = pos_profile_doc.company
    currency = pos_profile_doc.currency
    
    # Create sales order
    so_doc = frappe.get_doc({
        "doctype": "Sales Order",
        "customer": customer,
        "company": company,
        "currency": currency,
        "transaction_date": nowdate(),
        "delivery_date": nowdate(),
        "pos_profile": pos_profile,
    })
    
    # Add items
    items = data.get("items", [])
    if not items:
        frappe.throw(_("At least one item is required"))
    
    for item_data in items:
        item_code = item_data.get("item_code")
        item_name = item_data.get("item_name")
        
        # If item_code is provided, use it (item was selected from list)
        if item_code and frappe.db.exists("Item", item_code):
            # Item exists, use it
            item_doc = frappe.get_doc("Item", item_code)
        elif item_name:
            # No item_code or item doesn't exist, create new item
            item_code = _create_item_if_not_exists(item_name, settings, company)
            item_doc = frappe.get_doc("Item", item_code)
        else:
            # Skip if neither item_code nor item_name provided
            continue
        
        so_doc.append("items", {
            "item_code": item_code,
            "item_name": item_doc.item_name,
            "qty": flt(item_data.get("qty", 1)),
            "rate": flt(item_data.get("rate", 0)),
            "uom": item_data.get("uom") or item_doc.stock_uom,
            "warehouse": pos_profile_doc.warehouse if hasattr(pos_profile_doc, "warehouse") else None,
        })
    
    so_doc.flags.ignore_permissions = True
    frappe.flags.ignore_account_permission = True
    so_doc.save()
    so_doc.submit()
    
    # Create payment entry if advance amount
    advance_amount = flt(data.get("advance_amount", 0))
    if advance_amount > 0:
        mode_of_payment = data.get("mode_of_payment")
        if not mode_of_payment:
            frappe.throw(_("Mode of payment is required for advance payment"))
        
        pe = create_payment_entry(
            company=company,
            customer=customer,
            amount=advance_amount,
            currency=currency,
            mode_of_payment=mode_of_payment,
            reference_no=so_doc.name,
            reference_date=nowdate(),
            posting_date=nowdate(),
            submit=0,
        )
        
        # Link to sales order
        pe.append("references", {
            "reference_doctype": "Sales Order",
            "reference_name": so_doc.name,
            "allocated_amount": advance_amount,
        })
        
        pe.flags.ignore_permissions = True
        frappe.flags.ignore_account_permission = True
        pe.save()
        pe.submit()
    
    return {
        "name": so_doc.name,
        "customer": customer,
        "customer_name": customer_name,
        "mobile_no": mobile_no,
    }


@frappe.whitelist()
def list_minimal_sales_orders(company=None, customer_name=None, mobile_no=None):
    """List sales orders with customer info."""
    filters = {
        "docstatus": 1,
        "billing_status": ["in", ["Not Billed", "Partly Billed"]],
    }
    
    if company:
        filters["company"] = company
    
    if customer_name:
        filters["customer_name"] = ["like", f"%{customer_name}%"]
    
    if mobile_no:
        # Find customer by phone first
        customer = _find_customer_by_phone(mobile_no)
        if customer:
            filters["customer"] = customer
        else:
            # Return empty if no customer found
            return []
    
    orders = frappe.get_all(
        "Sales Order",
        filters=filters,
        fields=["name", "customer", "customer_name", "transaction_date", "grand_total", "currency"],
        order_by="transaction_date desc",
        limit=100,
    )
    
    # Get mobile numbers for customers
    for order in orders:
        if order.customer:
            mobile = frappe.db.get_value("Customer", order.customer, "mobile_no")
            order["mobile_no"] = mobile or ""
    
    return orders


@frappe.whitelist()
def get_sales_order_data_for_invoice(sales_order_name):
    """Get sales order data to load into POS invoice."""
    # Get sales order
    so_doc = frappe.get_doc("Sales Order", sales_order_name)
    
    # Get customer info
    customer_doc = frappe.get_doc("Customer", so_doc.customer)
    
    # Calculate advance payment amount
    advance_payments = frappe.get_all(
        "Payment Entry Reference",
        filters={
            "reference_doctype": "Sales Order",
            "reference_name": sales_order_name,
        },
        fields=["parent", "allocated_amount"],
    )
    
    total_advance = 0
    for pe_ref in advance_payments:
        pe_doc = frappe.get_doc("Payment Entry", pe_ref.parent)
        if pe_doc.docstatus == 1:
            total_advance += flt(pe_ref.allocated_amount)
    
    # Prepare items data with sales order linking
    items_data = []
    for item in so_doc.items:
        # Get item doc to fetch stock_uom if uom is not set
        item_doc = frappe.get_doc("Item", item.item_code)
        uom = item.uom or item_doc.stock_uom or "Nos"
        
        items_data.append({
            "item_code": item.item_code,
            "item_name": item.item_name,
            "qty": item.qty,
            "rate": item.rate,
            "uom": uom,
            "stock_uom": item_doc.stock_uom or "Nos",
            "warehouse": item.warehouse,
            "sales_order": sales_order_name,
            "so_detail": item.name,  # Sales Order Item detail name
        })
    
    return {
        "customer": so_doc.customer,
        "customer_name": customer_doc.customer_name,
        "mobile_no": customer_doc.mobile_no or "",
        "items": items_data,
        "advance_paid": total_advance,
        "sales_order": sales_order_name,
        "company": so_doc.company,
        "currency": so_doc.currency,
    }


@frappe.whitelist()
def create_sales_invoice_from_minimal_order(sales_order_name, items=None, customer_name=None, mobile_no=None):
    """Create sales invoice from minimal sales order with advance payment deduction."""
    # Get sales order
    so_doc = frappe.get_doc("Sales Order", sales_order_name)
    
    # Find or create customer if provided
    customer = so_doc.customer
    if customer_name or mobile_no:
        if mobile_no:
            found_customer = _find_customer_by_phone(mobile_no)
            if found_customer:
                customer = found_customer
            elif customer_name:
                # Create new customer
                settings = frappe.get_cached_doc("Fateh POS Settings", "Fateh POS Settings")
                pos_profile_doc = json.dumps({
                    "posa_allow_duplicate_customer_names": 1
                })
                customer_doc = create_customer(
                    customer_name=customer_name,
                    company=so_doc.company,
                    pos_profile_doc=pos_profile_doc,
                    mobile_no=mobile_no,
                    method="create"
                )
                customer = customer_doc.name
        elif customer_name:
            # Just update customer name
            frappe.db.set_value("Customer", customer, "customer_name", customer_name)
    
    # Create sales invoice from sales order
    si_doc = make_sales_invoice(sales_order_name)
    si_doc.customer = customer
    si_doc.is_pos = 1
    si_doc.pos_profile = so_doc.pos_profile
    
    # Update items if provided
    if items:
        items_data = json.loads(items) if isinstance(items, str) else items
        si_doc.items = []
        for item_data in items_data:
            si_doc.append("items", {
                "item_code": item_data.get("item_code"),
                "item_name": item_data.get("item_name"),
                "qty": flt(item_data.get("qty", 1)),
                "rate": flt(item_data.get("rate", 0)),
                "uom": item_data.get("uom"),
                "warehouse": item_data.get("warehouse"),
            })
    
    # Calculate advance payment amount
    advance_payments = frappe.get_all(
        "Payment Entry Reference",
        filters={
            "reference_doctype": "Sales Order",
            "reference_name": sales_order_name,
        },
        fields=["parent", "allocated_amount"],
    )
    
    total_advance = 0
    for pe_ref in advance_payments:
        pe_doc = frappe.get_doc("Payment Entry", pe_ref.parent)
        if pe_doc.docstatus == 1:
            total_advance += flt(pe_ref.allocated_amount)
    
    # Set advance paid - this will be deducted from outstanding
    si_doc.advance_paid = total_advance
    
    si_doc.flags.ignore_permissions = True
    frappe.flags.ignore_account_permission = True
    si_doc.save()
    
    return si_doc.as_dict()


@frappe.whitelist()
def get_pos_profile_payment_modes(pos_profile_data):
    """Get payment modes from POS Profile payments field."""
    if not pos_profile_data:
        return []
    
    # pos_profile_data can be a string (JSON) or dict
    if isinstance(pos_profile_data, str):
        import json
        pos_profile_data = json.loads(pos_profile_data)
    
    # Get payments directly from pos_profile
    payments = pos_profile_data.get("payments", [])
    
    result = []
    for payment in payments:
        mode_data = {
            "mode_of_payment": payment.get("mode_of_payment"),
        }
        # Include 'type' if it exists (Sales Invoice Payment has it)
        if "type" in payment:
            mode_data["type"] = payment.get("type")
        result.append(mode_data)
    
    return result


@frappe.whitelist()
def search_items(search_term, limit=20):
    """Search for items by name or code."""
    # Validate and clean search_term
    if not search_term:
        return []
    
    # Handle string input
    if isinstance(search_term, str):
        search_term = search_term.strip()
        # Check for invalid values like "undefined"
        if not search_term or search_term.lower() in ["undefined", "null", "none", ""] or len(search_term) < 2:
            return []
    else:
        return []
    
    # Ensure limit is an integer and safe
    try:
        limit = int(limit) if limit else 20
        if limit > 100:  # Safety limit
            limit = 100
        if limit < 1:
            limit = 20
    except (ValueError, TypeError):
        limit = 20
    
    search_pattern = f"%{search_term}%"
    exact_start_pattern = f"{search_term}%"
    
    # LIMIT cannot use parameter placeholder in MySQL/MariaDB, so format it directly
    # But we've validated limit is a safe integer, so this is safe
    items = frappe.db.sql("""
        SELECT name as item_code, item_name, item_group, stock_uom
        FROM `tabItem`
        WHERE (item_name LIKE %s OR name LIKE %s)
        AND disabled = 0
        ORDER BY 
            CASE 
                WHEN name LIKE %s THEN 1
                WHEN item_name LIKE %s THEN 2
                ELSE 3
            END,
            item_name
        LIMIT {limit}
    """.format(limit=limit), (search_pattern, search_pattern, exact_start_pattern, exact_start_pattern), as_dict=True)
    
    return items


@frappe.whitelist()
def get_minimal_sales_order_defaults():
    """Get default values from settings."""
    settings = frappe.get_cached_doc("Fateh POS Settings", "Fateh POS Settings")
    
    return {
        "enabled": settings.get("enable_minimal_sales_order") or 0,
        "default_item_group": settings.get("default_item_group") or "",
        "default_uom": settings.get("default_uom") or "Nos",
        "default_item": settings.get("default_item") or "",
    }


@frappe.whitelist()
def get_advance_payments_for_sales_order(sales_order_name):
    """Get advance payment entries linked to a sales order."""
    if not sales_order_name:
        return []
    
    # Get advance payment entries linked to this sales order
    advance_refs = frappe.get_all(
        "Payment Entry Reference",
        filters={
            "reference_doctype": "Sales Order",
            "reference_name": sales_order_name,
        },
        fields=["parent", "allocated_amount"],
    )
    
    result = []
    for pe_ref in advance_refs:
        pe_doc = frappe.get_doc("Payment Entry", pe_ref.parent)
        if pe_doc.docstatus == 1:  # Only submitted payment entries
            result.append({
                "payment_entry": pe_ref.parent,
                "advance_amount": flt(pe_ref.allocated_amount),  # Amount allocated to Sales Order
                "allocated_amount": flt(pe_ref.allocated_amount),  # Amount allocated to Sales Order
                "remarks": pe_doc.remarks or "",
            })
    
    return result

