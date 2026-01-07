/* global flt, __, get_currency_symbol */
import { perfMarkStart, perfMarkEnd } from "../../utils/perf.js";

import { parseBooleanSetting } from "../../utils/stock.js";

export default {
	// Calculate total quantity of all items
	total_qty() {
		const mark = perfMarkStart("pos:totals-total_qty");
		this.close_payments();
		const store = this.invoiceStore;
		const storeValue = store?.totalQty?.value ?? store?.totalQty;
		let qty;

		if (typeof storeValue === "number" && !Number.isNaN(storeValue)) {
			qty = storeValue;
		} else {
			qty = 0;
			this.items.forEach((item) => {
				qty += flt(item.qty);
			});
		}

		const result = this.flt(qty, this.float_precision);
		perfMarkEnd("pos:totals-total_qty", mark);
		return result;
	},
	// Calculate total amount for all items (handles returns)
	Total() {
		const mark = perfMarkStart("pos:totals-gross");
		const store = this.invoiceStore;
		const storeValue = store?.grossTotal?.value ?? store?.grossTotal;
		let sum;

		if (typeof storeValue === "number" && !Number.isNaN(storeValue)) {
			sum = this.isReturnInvoice ? Math.abs(storeValue) : storeValue;
		} else {
			sum = 0;
			this.items.forEach((item) => {
				// For returns, use absolute value for correct calculation
				const qty = this.isReturnInvoice ? Math.abs(flt(item.qty)) : flt(item.qty);
				const rate = flt(item.rate);
				sum += qty * rate;
			});
		}

		const result = this.flt(sum, this.currency_precision);
		perfMarkEnd("pos:totals-gross", mark);
		return result;
	},
	// Calculate subtotal after discounts and delivery charges
	subtotal() {
		const mark = perfMarkStart("pos:totals-subtotal");
		this.close_payments();
		const store = this.invoiceStore;
		const storeValue = store?.grossTotal?.value ?? store?.grossTotal;
		let sum = typeof storeValue === "number" && !Number.isNaN(storeValue) ? storeValue : 0;

		if (!(typeof storeValue === "number" && !Number.isNaN(storeValue))) {
			this.items.forEach((item) => {
				// For returns, preserve the negative sign (don't use Math.abs)
				// Quantities are already negative for returns (e.g., -1.00), so the calculation will result in negative total
				const qty = flt(item.qty);
				const rate = flt(item.rate);
				sum += qty * rate;
			});
		}
		// For return invoices, ensure the total is negative (don't convert to positive with Math.abs)
		// If storeValue is positive but it's a return, we need to make it negative
		if (this.isReturnInvoice) {
			// Ensure the sum is negative for return invoices
			if (sum > 0) {
				sum = -sum;
			}
		}

		// Subtract additional discount (for returns, this should increase the negative amount)
		const additional_discount = this.flt(this.additional_discount);
		sum -= additional_discount;

		// Add delivery charges (for returns, this should reduce the negative amount)
		const delivery_charges = this.flt(this.delivery_charges_rate);
		sum += delivery_charges;

		const result = this.flt(sum, this.currency_precision);
		perfMarkEnd("pos:totals-subtotal", mark);
		return result;
	},
	// Calculate total discount amount for all items
	total_items_discount_amount() {
		const mark = perfMarkStart("pos:totals-discount");
		const store = this.invoiceStore;
		const storeValue = store?.discountTotal?.value ?? store?.discountTotal;
		let sum;

		if (typeof storeValue === "number" && !Number.isNaN(storeValue)) {
			sum = this.isReturnInvoice ? Math.abs(storeValue) : storeValue;
		} else {
			sum = 0;
			this.items.forEach((item) => {
				// For returns, use absolute value for correct calculation
				if (this.isReturnInvoice) {
					sum += Math.abs(flt(item.qty)) * flt(item.discount_amount);
				} else {
					sum += flt(item.qty) * flt(item.discount_amount);
				}
			});
		}

		const result = this.flt(sum, this.float_precision);
		perfMarkEnd("pos:totals-discount", mark);
		return result;
	},
	// Format posting_date for display as DD-MM-YYYY
	formatted_posting_date: {
		get() {
			if (!this.posting_date) return "";
			const parts = this.posting_date.split("-");
			if (parts.length === 3) {
				return `${parts[2]}-${parts[1]}-${parts[0]}`;
			}
			return this.posting_date;
		},
		set(val) {
			const parts = val.split("-");
			if (parts.length === 3) {
				this.posting_date = `${parts[2]}-${parts[1]}-${parts[0]}`;
			} else {
				this.posting_date = val;
			}
		},
	},
	// Get currency symbol for display
	currencySymbol() {
		return (currency) => {
			return get_currency_symbol(currency || this.selected_currency || this.pos_profile.currency);
		};
	},
	// Get display currency
	displayCurrency() {
		return this.selected_currency || this.pos_profile.currency;
	},
	// Determine if current invoice is a return
	isReturnInvoice() {
		return this.invoiceType === "Return" || (this.invoice_doc && this.invoice_doc.is_return);
	},
	blockSaleBeyondAvailableQty() {
		if (["Order", "Quotation"].includes(this.invoiceType)) {
			return false;
		}
		const allowNegative = parseBooleanSetting(this.stock_settings?.allow_negative_stock);
		return !allowNegative && Boolean(this.pos_profile?.posa_block_sale_beyond_available_qty);
	},
	// Table headers for item table (for another table if needed)
	itemTableHeaders() {
		return [
			{
				text: __("Item"),
				value: "item_name",
				width: "35%",
			},
			{
				text: __("Qty"),
				value: "qty",
				width: "15%",
			},
			{
				text: __(`Rate (${this.displayCurrency})`),
				value: "rate",
				width: "20%",
			},
			{
				text: __(`Amount (${this.displayCurrency})`),
				value: "amount",
				width: "20%",
			},
			{
				text: __("Action"),
				value: "actions",
				sortable: false,
				width: "10%",
			},
		];
	},
	// Sales Order Advance Amount - calculated from invoice_doc.advances
	total_advance() {
		if (!this.invoice_doc) return 0;
		// Access advances from invoice_doc (which comes from store)
		// Force reactivity by accessing the property
		const advances = this.invoice_doc.advances;
		if (!advances || !Array.isArray(advances) || advances.length === 0) {
			return 0;
		}
		// Calculate total from advances array
		const total = advances.reduce((sum, advance) => {
			// Use allocated_amount (amount allocated to this invoice) not advance_amount
			const amount = parseFloat(advance.allocated_amount) || 0;
			return sum + amount;
		}, 0);
		return this.flt(total, this.currency_precision);
	},
	// Balance after advance
	balance_after_advance() {
		if (!this.invoice_doc) return 0;
		// Use real-time calculated subtotal instead of saved grand_total
		// This ensures balance updates when items are added/removed
		const invoice_total = this.flt(this.subtotal, this.currency_precision);
		const advance = this.total_advance;
		return this.flt(invoice_total - advance, this.currency_precision);
	},
	// Check if has sales order
	has_sales_order() {
		if (!this.invoice_doc) return false;
		if (this.invoice_doc.sales_order) return true;
		if (this.invoice_doc.items && Array.isArray(this.invoice_doc.items)) {
			return this.invoice_doc.items.some(item => item.sales_order);
		}
		return false;
	},
};
