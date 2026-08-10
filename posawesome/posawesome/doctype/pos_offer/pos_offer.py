# -*- coding: utf-8 -*-
# Copyright (c) 2021, Youssef Restom and contributors
# For license information, please see license.txt

from __future__ import unicode_literals

import frappe
from frappe.model.document import Document
from frappe.utils import flt


class POSOffer(Document):
    def validate(self):
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
