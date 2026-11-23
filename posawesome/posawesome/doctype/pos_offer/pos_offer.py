# -*- coding: utf-8 -*-
# Copyright (c) 2021, Youssef Restom and contributors
# For license information, please see license.txt

from __future__ import unicode_literals

import datetime

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_days, flt, format_datetime, get_time, getdate, now_datetime

DAY_START = datetime.time(0, 0, 0)
DAY_END = datetime.time(23, 59, 59)

# Time Mode (only when "Time Bound" is ticked):
#   START_TO_END -- one continuous window: Valid From + Start Time -> Valid Upto + End Time
#                   (e.g. today 09:00 -> tomorrow 12:00).
#   EVERY_DAY    -- Valid From/Upto pick the days; the offer runs only between Start Time and
#                   End Time on each of them (e.g. 1st-10th, 09:00-12:00 daily). An End Time
#                   earlier than the Start Time is an overnight window (22:00-02:00) that belongs
#                   to the day it starts on.
START_TO_END = "Start to End"
EVERY_DAY = "Every Day"


def get_offer_validity(offer):
    """The offer's validity as plain parts: (mode, from_date, upto_date, start_time, end_time).

    start_time/end_time are None when the offer is not time bound -- the times are ignored then
    because Frappe stamps the current time into every empty Time field of a new document
    (create_new.py / create_new.js), so their mere presence means nothing.
    """
    from_date = getdate(offer.get("valid_from")) if offer.get("valid_from") else None
    upto_date = getdate(offer.get("valid_upto")) if offer.get("valid_upto") else None
    mode = EVERY_DAY if offer.get("time_mode") == EVERY_DAY else START_TO_END
    if not offer.get("time_bound"):
        return START_TO_END, from_date, upto_date, None, None
    start = get_time(offer.get("valid_from_time")) if offer.get("valid_from_time") else DAY_START
    end = get_time(offer.get("valid_upto_time")) if offer.get("valid_upto_time") else DAY_END
    return mode, from_date, upto_date, start, end


def get_offer_validity_payload(offer):
    """The same parts as strings for the till (see isOfferActiveNow in invoiceOfferMethods.js)."""
    mode, from_date, upto_date, start, end = get_offer_validity(offer)
    return {
        "mode": mode,
        "from_date": from_date.strftime("%Y-%m-%d") if from_date else None,
        "upto_date": upto_date.strftime("%Y-%m-%d") if upto_date else None,
        "start": start.strftime("%H:%M:%S") if start else None,
        "end": end.strftime("%H:%M:%S") if end else None,
    }


def _first_and_last_moment(offer):
    """(first, last) datetime the offer can ever be active; either side None when open."""
    mode, from_date, upto_date, start, end = get_offer_validity(offer)
    first = datetime.datetime.combine(from_date, start or DAY_START) if from_date else None
    last = None
    if upto_date:
        last_day = upto_date
        if mode == EVERY_DAY and start is not None and end < start:
            last_day = add_days(upto_date, 1)
        last = datetime.datetime.combine(getdate(last_day), end or DAY_END)
    return first, last


def is_offer_active_at(offer, now=None):
    now = (now or now_datetime()).replace(microsecond=0)
    mode, from_date, upto_date, start, end = get_offer_validity(offer)

    if mode != EVERY_DAY or start is None:
        first, last = _first_and_last_moment(offer)
        return (not first or now >= first) and (not last or now <= last)

    today, time = now.date(), now.time()

    def in_range(day):
        return (not from_date or day >= from_date) and (not upto_date or day <= upto_date)

    if start <= end:
        return in_range(today) and start <= time <= end
    # overnight window: the part after midnight belongs to yesterday's window
    if time >= start:
        return in_range(today)
    if time <= end:
        return in_range(add_days(today, -1))
    return False


def get_offer_validity_status(offer, now=None):
    """'Active', 'Not Started', 'Expired' or 'Outside Hours' (Every Day mode: inside the dates,
    outside the daily hours) for the given moment -- defaults to now, site time."""
    now = (now or now_datetime()).replace(microsecond=0)
    if is_offer_active_at(offer, now):
        return "Active"
    first, last = _first_and_last_moment(offer)
    if first and now < first:
        return "Not Started"
    if last and now > last:
        return "Expired"
    return "Outside Hours"


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
        # Don't keep times that don't count (see get_offer_validity): the auto-stamped "now" on
        # an unticked offer would sit in the DB looking live.
        if not self.time_bound:
            self.valid_from_time = None
            self.valid_upto_time = None
        if not self.time_mode:
            self.time_mode = START_TO_END
        # Start to End: an End Time only means something on the end date.
        if self.time_mode == START_TO_END and not self.valid_upto:
            self.valid_upto_time = None

        if self.valid_from and self.valid_upto and getdate(self.valid_upto) < getdate(self.valid_from):
            frappe.throw(_("Valid Upto cannot be before Valid From"))

        if not self.time_bound:
            return
        if self.time_mode == EVERY_DAY:
            _mode, _from, _upto, start, end = get_offer_validity(self)
            if start == end:
                frappe.throw(_("End Time must be different from Start Time"))
        else:
            first, last = _first_and_last_moment(self)
            if first and last and last <= first:
                frappe.throw(
                    _("The offer must end after it starts ({0} is not after {1})").format(
                        format_datetime(last), format_datetime(first)
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
