// Copyright (c) 2021, Youssef Restom and contributors
// For license information, please see license.txt

frappe.ui.form.on("POS Offer", {
	setup: function (frm) {
		set_filters(frm);
		controllers(frm);
	},
	refresh: function (frm) {
		controllers(frm);
		update_combo_totals(frm);
	},
	onload: function (frm) {
		set_filters(frm);
		controllers(frm);
		update_combo_totals(frm);
	},
	validate: function (frm) {
		if (frm.doc.apply_on === "Transaction") {
			if (!frm.doc.min_amt > 0) {
				frappe.throw("Min Amount most be more then zero");
			}
		}
		if (frm.doc.offer === "Give Product") {
			if (!frm.doc.given_qty > 0) {
				frappe.throw("Given Quantity most be more then zero");
			}
		}
		if (frm.doc.offer === "Loyalty Point") {
			if (!frm.doc.loyalty_points > 0) {
				frappe.throw("Loyalty Points most be more then zero");
			}
		}
		if (frm.doc.apply_on === "Item Combination") {
			if (!frm.doc.combo_items || frm.doc.combo_items.length < 2) {
				frappe.throw("Add at least 2 Combo Items");
			}
			if (
				frm.doc.offer === "Item Price" &&
				(frm.doc.discount_type !== "Discount Amount" || !frm.doc.discount_amount > 0)
			) {
				frappe.throw("Combo offers with Promo Type 'Item Price' must use Discount Type 'Discount Amount' with a value greater than zero");
			}
		}
		if (
			frm.doc.apply_type === "Item Group" &&
			frm.doc.offer === "Give Product" &&
			!frm.doc.replace_item &&
			!frm.doc.replace_cheapest_item
		) {
			frm.set_value("auto", 0);
		}
	},
	apply_on: function (frm) {
		controllers(frm);
	},
	offer: function (frm) {
		controllers(frm);
	},
	apply_type: function (frm) {
		controllers(frm);
	},
	discount_type: function (frm) {
		controllers(frm);
	},
	replace_item: function (frm) {
		controllers(frm);
	},
	replace_cheapest_item: function (frm) {
		controllers(frm);
	},
	discount_amount: function (frm) {
		update_combo_totals(frm);
	},
	discount_percentage: function (frm) {
		update_combo_totals(frm);
	},
	pos_profile: function (frm) {
		// Price list source changed -- re-resolve every combo row's reference rate
		// against the new POS Profile's price list.
		(frm.doc.combo_items || []).forEach((row) => fetch_combo_row_rate(frm, row.doctype, row.name));
	},
});

frappe.ui.form.on("POS Offer Combo Item", {
	item_code: function (frm, cdt, cdn) {
		const row = frappe.get_doc(cdt, cdn);
		if (!row.item_code) {
			return;
		}
		// Default the UOM to the item's stock UOM the first time an item is picked (the
		// user can then switch to any UOM configured on the item, e.g. "Box"); either way
		// re-resolve the reference rate for whatever UOM ends up set.
		if (!row.uom) {
			frappe.db.get_value("Item", row.item_code, "stock_uom").then(({ message }) => {
				if (message && message.stock_uom && !row.uom) {
					frappe.model.set_value(cdt, cdn, "uom", message.stock_uom);
				}
				fetch_combo_row_rate(frm, cdt, cdn);
			});
		} else {
			fetch_combo_row_rate(frm, cdt, cdn);
		}
	},
	uom: function (frm, cdt, cdn) {
		fetch_combo_row_rate(frm, cdt, cdn);
	},
	qty: function (frm, cdt, cdn) {
		update_row_amount(frm, cdt, cdn);
		update_combo_totals(frm);
	},
	rate: function (frm, cdt, cdn) {
		update_row_amount(frm, cdt, cdn);
		update_combo_totals(frm);
	},
	combo_items_add: function (frm) {
		update_combo_totals(frm);
	},
	combo_items_remove: function (frm) {
		update_combo_totals(frm);
	},
});

// Rate must reflect the required qty's own UOM (e.g. "1 Box" prices differently to
// "1 Nos"), sourced from the POS Profile's price list -- falling back to the system
// default selling price list, then Item.standard_rate -- all resolved server-side so
// desk-form JS doesn't have to re-implement that fallback chain.
const fetch_combo_row_rate = (frm, cdt, cdn) => {
	const row = frappe.get_doc(cdt, cdn);
	if (!row || !row.item_code) {
		return;
	}
	frappe.call({
		method: "posawesome.posawesome.api.offers.get_combo_item_reference_rate",
		args: {
			item_code: row.item_code,
			uom: row.uom,
			pos_profile: frm.doc.pos_profile,
		},
		callback: (r) => {
			if (!r.message) {
				return;
			}
			frappe.model.set_value(cdt, cdn, "rate", r.message.rate);
			update_row_amount(frm, cdt, cdn);
			update_combo_totals(frm);
		},
	});
};

const update_row_amount = (frm, cdt, cdn) => {
	const row = frappe.get_doc(cdt, cdn);
	row.amount = flt(row.qty) * flt(row.rate);
	frm.fields_dict.combo_items.grid.refresh();
};

const update_combo_totals = (frm) => {
	const rows = frm.doc.combo_items || [];
	const total = rows.reduce((sum, row) => sum + flt(row.qty) * flt(row.rate), 0);
	frm.set_value("combo_total_amount", total);

	let priceAfterOffer = total;
	if (frm.doc.offer === "Item Price") {
		if (frm.doc.discount_type === "Discount Amount") {
			priceAfterOffer = Math.max(total - flt(frm.doc.discount_amount), 0);
		} else if (frm.doc.discount_type === "Discount Percentage") {
			priceAfterOffer = total - (total * flt(frm.doc.discount_percentage)) / 100;
		}
	}
	frm.set_value("combo_price_after_discount", priceAfterOffer);
};

const controllers = (frm) => {
	frm.toggle_display("item", frm.doc.apply_on === "Item Code");
	frm.toggle_reqd("item", frm.doc.apply_on === "Item Code");

	frm.toggle_display("item_group", frm.doc.apply_on === "Item Group");
	frm.toggle_reqd("item_group", frm.doc.apply_on === "Item Group");

	frm.toggle_display("brand", frm.doc.apply_on === "Brand");
	frm.toggle_reqd("brand", frm.doc.apply_on === "Brand");

	frm.toggle_display("combo_items_section", frm.doc.apply_on === "Item Combination");
	frm.toggle_display("combo_items", frm.doc.apply_on === "Item Combination");
	frm.toggle_reqd("combo_items", frm.doc.apply_on === "Item Combination");
	frm.toggle_display("combo_totals_section", frm.doc.apply_on === "Item Combination");
	frm.toggle_display("combo_total_amount", frm.doc.apply_on === "Item Combination");
	frm.toggle_display("column_break_combo_total", frm.doc.apply_on === "Item Combination");
	frm.toggle_display(
		"combo_price_after_discount",
		frm.doc.apply_on === "Item Combination" && frm.doc.offer === "Item Price",
	);

	frm.toggle_display("quantity_and_amount_section", frm.doc.apply_on !== "Item Combination");

	frm.toggle_reqd("min_amt", frm.doc.apply_on === "Transaction");

	frm.toggle_display("apply_for_section", frm.doc.offer === "Give Product");
	frm.toggle_reqd("apply_type", frm.doc.offer === "Give Product");

	frm.toggle_display(
		"replace_item",
		frm.doc.apply_on === "Item Code" &&
			frm.doc.offer === "Give Product" &&
			frm.doc.apply_type === "Item Code",
	);
	frm.toggle_display(
		"replace_cheapest_item",
		frm.doc.apply_on === "Item Group" &&
			frm.doc.offer === "Give Product" &&
			frm.doc.apply_type === "Item Group",
	);

	frm.toggle_display("apply_item_code", frm.doc.apply_type === "Item Code" && !frm.doc.replace_item);
	frm.toggle_reqd("apply_item_code", frm.doc.apply_type === "Item Code" && !frm.doc.replace_item);

	frm.toggle_display(
		"apply_item_group",
		frm.doc.apply_type === "Item Group" && !frm.doc.replace_cheapest_item,
	);
	frm.toggle_reqd(
		"apply_item_group",
		frm.doc.apply_type === "Item Group" && !frm.doc.replace_cheapest_item,
	);

	frm.toggle_display("less_then", frm.doc.apply_type === "Item Group" && !frm.doc.replace_cheapest_item);

	frm.toggle_display("product_discount_scheme_section", frm.doc.offer === "Give Product");
	frm.toggle_display("given_qty", frm.doc.offer === "Give Product");
	frm.toggle_reqd("given_qty", frm.doc.offer === "Give Product");

	frm.toggle_display("price_discount_scheme_section", frm.doc.offer !== "Loyalty Point");
	frm.toggle_display("discount_type", frm.doc.offer !== "Loyalty Point");
	frm.toggle_reqd("discount_type", frm.doc.offer !== "Loyalty Point");

	frm.toggle_display("rate", frm.doc.discount_type === "Rate");
	frm.toggle_reqd("rate", frm.doc.discount_type === "Rate");

	frm.toggle_display("discount_amount", frm.doc.discount_type === "Discount Amount");
	frm.toggle_reqd("discount_amount", frm.doc.discount_type === "Discount Amount");

	frm.toggle_display("discount_percentage", frm.doc.discount_type === "Discount Percentage");
	frm.toggle_reqd("discount_percentage", frm.doc.discount_type === "Discount Percentage");

	frm.toggle_display("loyalty_point_scheme_section", frm.doc.offer === "Loyalty Point");
	frm.toggle_display("loyalty_program", frm.doc.offer === "Loyalty Point");
	frm.toggle_reqd("loyalty_program", frm.doc.offer === "Loyalty Point");

	frm.toggle_display("loyalty_points", frm.doc.offer === "Loyalty Point");
	frm.toggle_reqd("loyalty_points", frm.doc.offer === "Loyalty Point");

	if (frm.doc.offer === "Grand Total") {
		frm.set_df_property("discount_type", "options", ["Discount Percentage"]);
	} else if (frm.doc.apply_on === "Item Combination" && frm.doc.offer === "Item Price") {
		frm.set_df_property("discount_type", "options", ["", "Discount Amount"]);
	} else {
		frm.set_df_property("discount_type", "options", [
			"",
			"Rate",
			"Discount Percentage",
			"Discount Amount",
		]);
	}

	if (frm.doc.apply_on === "Transaction") {
		frm.set_df_property("offer", "options", ["", "Give Product", "Grand Total", "Loyalty Point"]);
	} else if (frm.doc.apply_on === "Item Combination") {
		frm.set_df_property("offer", "options", ["", "Item Price", "Give Product"]);
	} else {
		frm.set_df_property("offer", "options", [
			"",
			"Item Price",
			"Give Product",
			"Grand Total",
			"Loyalty Point",
		]);
	}

	if (
		frm.doc.apply_type === "Item Group" &&
		frm.doc.offer === "Give Product" &&
		!frm.doc.replace_item &&
		!frm.doc.replace_cheapest_item
	) {
		frm.set_value("auto", 0);
	}
	if (
		frm.doc.apply_on !== "Item Code" ||
		frm.doc.offer !== "Give Product" ||
		frm.doc.apply_type !== "Item Code"
	) {
		frm.set_value("replace_item", 0);
	}
	if (
		frm.doc.apply_on !== "Item Group" ||
		frm.doc.offer !== "Give Product" ||
		frm.doc.apply_type !== "Item Group"
	) {
		frm.set_value("replace_cheapest_item", 0);
	}
};

const set_filters = (frm) => {
	frm.set_query("pos_profile", function () {
		return {
			filters: {
				company: frm.doc.company,
			},
		};
	});
	frm.set_query("warehouse", function () {
		return {
			filters: {
				company: frm.doc.company,
				is_group: 0,
			},
		};
	});
	frm.set_query("loyalty_program", function () {
		return {
			filters: {
				company: frm.doc.company,
			},
		};
	});
	frm.set_query("item_group", function () {
		return {
			filters: {
				is_group: 0,
			},
		};
	});
	frm.set_query("apply_item_group", function () {
		return {
			filters: {
				is_group: 0,
			},
		};
	});
	frm.set_query("uom", "combo_items", function (doc, cdt, cdn) {
		const row = frappe.get_doc(cdt, cdn);
		return {
			query: "erpnext.controllers.queries.get_item_uom_query",
			filters: { item_code: row.item_code },
		};
	});
};
