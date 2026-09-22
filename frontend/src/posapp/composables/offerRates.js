/* global flt */

// Shared "re-price a row that has an Item Price offer on it" logic.
//
// Several places outside the offer engine legitimately re-price a cart row after an offer has
// already been applied to it (a UOM switch, a price-list/customer change). Each of them used to
// either drop the discount silently or try to look the offer up on its own -- and the lookup they
// used could never succeed, see resolveAppliedItemPriceOffer below. Keeping the resolution and the
// rate math here means those paths and invoiceOfferMethods.ApplyOnPrice can't drift apart.

const getFlt = (context) => (context && typeof context.flt === "function" ? context.flt : flt);

// Find the POS Offer template behind the Item Price offer currently applied to this row.
//
// A cart row only stores offer ROW IDs (item.posa_offers). Those map to entries in the invoice's
// posa_offers list, and it's those entries that carry offer_name -- the docname of the template in
// posOffers. Searching posOffers directly for an entry whose `items` contains the row (which is
// what calc_uom used to do) can never match: templates come straight from the server and have no
// `items` field at all; it only exists on the evaluated copies and on the applied records.
export function resolveAppliedItemPriceOffer(item, context) {
	if (!item || !item.posa_offer_applied || !context) {
		return null;
	}

	let rowIds = [];
	try {
		const parsed = JSON.parse(item.posa_offers || "[]");
		if (Array.isArray(parsed)) {
			rowIds = parsed;
		}
	} catch {
		return null;
	}
	if (!rowIds.length) {
		return null;
	}

	const applied = Array.isArray(context.posa_offers) ? context.posa_offers : [];
	const templates = Array.isArray(context.posOffers) ? context.posOffers : [];

	for (const rowId of rowIds) {
		const record = applied.find((el) => el && el.row_id === rowId && el.offer === "Item Price");
		if (!record) {
			continue;
		}
		// An Item Combination discount is split proportionally across the combo's rows by
		// ApplyOnCombo and cannot be re-derived from the template's own discount fields, so
		// leave those rows to the combo pass rather than flattening them here.
		if (record.apply_on === "Item Combination") {
			continue;
		}
		const template = templates.find((el) => el && el.name === record.offer_name);
		if (template) {
			return template;
		}
	}

	return null;
}

// Discounted base rates for `basePrice` (the row's undiscounted price for its CURRENT uom).
// Mirrors ApplyOnPrice: only Rate and Discount Percentage change a rate, anything else returns
// null so the caller leaves the row's rate untouched instead of inventing a discount.
export function computeItemPriceOfferRates(offer, basePrice, conversionFactor, context) {
	const f = getFlt(context);
	const precision = context ? context.currency_precision : undefined;
	const cf = f(conversionFactor) || 1;
	const base_price = f(basePrice, precision);

	if (!offer || !(base_price > 0)) {
		return null;
	}

	let base_rate;
	if (offer.discount_type === "Rate") {
		base_rate = f(offer.rate * cf, precision);
	} else if (offer.discount_type === "Discount Percentage") {
		base_rate = f(base_price - (base_price * f(offer.discount_percentage)) / 100, precision);
	} else {
		return null;
	}

	if (base_rate < 0) {
		base_rate = 0;
	}

	const base_discount = f(base_price - base_rate, precision);
	return {
		base_price,
		base_rate,
		base_discount,
		discount_percentage: base_price ? f((base_discount / base_price) * 100, precision) : 0,
	};
}

// Re-apply the row's Item Price offer against a (possibly new) reference price and the row's
// current conversion factor, and move the original_* restore snapshot with it so RemoveOnPrice and
// the next recompute both see the reference price that's actually in force now.
//
// options.basePrice is the undiscounted price for ONE unit of the row's current uom; it defaults to
// the row's own snapshot scaled to the current conversion factor, which is what ApplyOnPrice uses.
// Returns false when there's nothing to re-apply, in which case the caller keeps its own behaviour.
export function reapplyItemPriceOffer(item, context, options = {}) {
	const offer = resolveAppliedItemPriceOffer(item, context);
	if (!offer) {
		return false;
	}

	const f = getFlt(context);
	const precision = context.currency_precision;
	const cf = f(item.conversion_factor || 1) || 1;
	const basePrice =
		options.basePrice != null
			? f(options.basePrice, precision)
			: f((item.original_base_price_list_rate ?? item.base_price_list_rate / cf) * cf, precision);

	const rates = computeItemPriceOfferRates(offer, basePrice, cf, context);
	if (!rates) {
		return false;
	}

	item.original_base_price_list_rate = f(rates.base_price / cf, precision);
	item.original_base_rate = item.original_base_price_list_rate;

	item.base_price_list_rate = rates.base_price;
	item.base_rate = rates.base_rate;
	item.base_discount_amount = rates.base_discount;
	item.discount_percentage = rates.discount_percentage;

	const baseCurrency = context.price_list_currency || context.pos_profile.currency;
	if (context.selected_currency !== baseCurrency) {
		const exchange_rate = context.exchange_rate || 1;
		item.price_list_rate = f(rates.base_price * exchange_rate, precision);
		item.rate = f(rates.base_rate * exchange_rate, precision);
		item.discount_amount = f(rates.base_discount * exchange_rate, precision);
		item.original_price_list_rate = f(item.original_base_price_list_rate * exchange_rate, precision);
	} else {
		item.price_list_rate = rates.base_price;
		item.rate = rates.base_rate;
		item.discount_amount = rates.base_discount;
		item.original_price_list_rate = item.original_base_price_list_rate;
	}
	item.original_rate = item.original_price_list_rate;

	item.amount = f(item.qty * item.rate, precision);
	item.base_amount = f(item.qty * item.base_rate, precision);

	return true;
}
