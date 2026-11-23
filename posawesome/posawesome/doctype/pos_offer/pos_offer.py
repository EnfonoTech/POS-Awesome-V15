# -*- coding: utf-8 -*-
# Copyright (c) 2021, Youssef Restom and contributors
# For license information, please see license.txt

from __future__ import unicode_literals

import datetime

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, format_datetime, get_time, getdate, now_datetime

DATETIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def get_offer_window(offer):
    """Return (start, end) datetimes of an offer's validity window, in site time.

    The date fields decide the days; with "Time Bound" ticked the time fields narrow the first
    and last day (e.g. 23rd 09:00 -> 24th 12:00). Otherwise it runs from the start of the first
    day to the end of the last, exactly as a date-only offer always has. The times are ignored
    unless time_bound is set because Frappe stamps the current time into every empty Time field
    of a new document (create_new.py / create_new.js), so their mere presence means nothing.
    Either side is None when its date is not set.
    """
    use_times = bool(offer.get("time_bound"))
    from_time = offer.get("valid_from_time") if use_times else None
    upto_time = offer.get("valid_upto_time") if use_times else None

    start = end = None
    if offer.get("valid_from"):
        start = datetime.datetime.combine(
            getdate(offer.get("valid_from")),
            get_time(from_time) if from_time else datetime.time.min,
        )
    if offer.get("valid_upto"):
        end = datetime.datetime.combine(
            getdate(offer.get("valid_upto")),
            get_time(upto_time) if upto_time else datetime.time(23, 59, 59),
        )
    return start, end


def get_offer_window_strings(offer):
    start, end = get_offer_window(offer)
    return (
        start.strftime(DATETIME_FORMAT) if start else None,
        end.strftime(DATETIME_FORMAT) if end else None,
    )


def get_offer_validity_status(offer, now=None):
    """'Not Started', 'Expired' or 'Active' for the given moment (defaults to now, site time)."""
    now = now or now_datetime()
    start, end = get_offer_window(offer)
    if start and now < start:
        return "Not Started"
    if end and now > end:
        return "Expired"
    return "Active"


class POSOffer(Document):
    def validate(self):
        self.validate_validity_window()
        if self.apply_on == "Item Combination":
            if len(self.combo_items or []) < 2:
                frappe.throw("Add at least 2 Combo Items")
            if self.offer == "Item Price" and (
                self.discount_type != "Discount Amount" or not self.discount_amount
            ):
                frappe.throw(
                    "Combo offers with Promo Type 'Item Price' must use Discount Type "
                    "'Discount Amount' with a value greater than zero"
                )
            self.update_combo_totals()

    def validate_validity_window(self):
        # Don't keep times that don't count (see get_offer_window): the auto-stamped "now" on an
        # unticked offer, or an end time with no end date, would sit in the DB looking live.
        if not self.time_bound:
            self.valid_from_time = None
            self.valid_upto_time = None
        if not self.valid_upto:
            self.valid_upto_time = None

        start, end = get_offer_window(self)
        if start and end and end <= start:
            frappe.throw(
                _("Valid Upto ({0}) must be after Valid From ({1})").format(
                    format_datetime(end), format_datetime(start)
                )
            )

    def update_combo_totals(self):
        # Child doctype controllers' own validate() is never invoked by the framework
        # during a parent save, so these reference figures (row amount, combo total,
        # price after offer) have to be computed here instead.
        total = 0.0
        for row in self.combo_items or []:
            row.amount = flt(row.qty) * flt(row.rate)
            total += row.amount

        self.combo_total_amount = total

        price_after_discount = total
        if self.offer == "Item Price":
            if self.discount_type == "Discount Amount":
                price_after_discount = max(total - flt(self.discount_amount), 0)
            elif self.discount_type == "Discount Percentage":
                price_after_discount = total - (total * flt(self.discount_percentage)) / 100
        self.combo_price_after_discount = price_after_discount
