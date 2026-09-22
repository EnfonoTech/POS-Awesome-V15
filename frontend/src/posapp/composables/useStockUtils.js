import { isOffline } from "../../offline/index.js";
import { reapplyItemPriceOffer } from "./offerRates.js";

/* global __, frappe */

export function useStockUtils() {
	// Calculate UOM conversion and update item rates
	const calcUom = async (item, value, context) => {
		let new_uom = item.item_uoms.find((element) => element.uom == value);

		// try cached uoms when not found on item
		if (!new_uom && context.getItemUOMs) {
			const cached = context.getItemUOMs(item.item_code);
			if (cached.length) {
				item.item_uoms = cached;
				new_uom = cached.find((u) => u.uom == value);
			}
		}

		// fallback to stock uom
		if (!new_uom && item.stock_uom === value) {
			new_uom = { uom: item.stock_uom, conversion_factor: 1 };
			if (!item.item_uoms) item.item_uoms = [];
			item.item_uoms.push(new_uom);
		}

		if (!new_uom) {
			context.eventBus.emit("show_message", {
				title: __("UOM not found"),
				color: "error",
			});
			return;
		}

		// Store old conversion factor for ratio calculation
		const old_conversion_factor = item.conversion_factor || 1;

		// Update conversion factor
		item.conversion_factor = new_uom.conversion_factor;

		// Try to fetch rate for this UOM from price list
		const priceList = context.get_price_list ? context.get_price_list() : null;
		let uomRate = null;
		if (priceList && context.getCachedPriceListItems) {
			const cached = context.getCachedPriceListItems(priceList) || [];
			const match = cached.find((p) => p.item_code === item.item_code && p.uom === new_uom.uom);
			if (match) {
				uomRate = match.price_list_rate ?? match.rate ?? 0;
			}
		}
		if (!uomRate && typeof isOffline === "function" && !isOffline()) {
			try {
				const r = await frappe.call({
					method: "posawesome.posawesome.api.items.get_price_for_uom",
					args: {
						item_code: item.item_code,
						price_list: priceList,
						uom: new_uom.uom,
					},
				});
				if (r.message) {
					uomRate = parseFloat(r.message);
				}
			} catch (e) {
				console.error("Failed to fetch UOM price", e);
			}
		}

                if (uomRate) {
                        item._manual_rate_set = true;

			// default rates based on fetched UOM price
			const base_price = uomRate;
			const base_rate = uomRate;
			const base_discount = 0;

			// Reapply offer if present. uomRate is this uom's own undiscounted price, so the
			// offer has to be re-derived from it -- and the row's reference snapshot has to move
			// with it, which is why this goes through the shared helper rather than only
			// adjusting rate/base_rate here. It writes every rate field itself when it succeeds.
			if (item.posa_offer_applied && reapplyItemPriceOffer(item, context, { basePrice: uomRate })) {
				if (context.calc_stock_qty) context.calc_stock_qty(item, item.qty);
				if (context.forceUpdate) context.forceUpdate();
				return;
			}

			item.base_price_list_rate = base_price;
			item.base_rate = base_rate;
			item.base_discount_amount = base_discount;

			const baseCurrency = context.price_list_currency || context.pos_profile.currency;
			if (context.selected_currency !== baseCurrency) {
				item.price_list_rate = context.flt(
					base_price * context.exchange_rate,
					context.currency_precision,
				);
				item.rate = context.flt(base_rate * context.exchange_rate, context.currency_precision);
				item.discount_amount = context.flt(
					base_discount * context.exchange_rate,
					context.currency_precision,
				);
			} else {
				item.price_list_rate = base_price;
				item.rate = base_rate;
				item.discount_amount = base_discount;
			}

			if (context.calc_stock_qty) context.calc_stock_qty(item, item.qty);
			if (context.forceUpdate) context.forceUpdate();
			return;
		}

                // No explicit UOM price found, allow normal recalculation but
                // lock the rate when the user selected a non-stock UOM so the
                // backend refresh (triggered when opening payments) does not
                // revert the displayed rate back to the single-unit price.
                const shouldPreserveManualRate =
                        value !== item.stock_uom || item.conversion_factor !== 1;
                item._manual_rate_set = shouldPreserveManualRate;

		// Reset discount if not offer
                if (!item.posa_offer_applied) {
			item.discount_amount = 0;
			item.discount_percentage = 0;
		}

		// Store original base rates if not already stored
		if (!item.original_base_rate && !item.posa_offer_applied) {
			item.original_base_rate = item.base_rate / old_conversion_factor;
			item.original_base_price_list_rate = item.base_price_list_rate / old_conversion_factor;
		}

		// Update rates based on new conversion factor
		if (item.posa_offer_applied) {
			// Re-derive the offer against the row's reference price scaled to the NEW conversion
			// factor. reapplyItemPriceOffer resolves the offer through the row's posa_offers ->
			// the invoice's posa_offers -> the template; the lookup that used to sit here searched
			// context.posOffers for an entry whose `items` held this row, which can never match
			// (templates carry no `items` field), so the discount was silently dropped on every
			// uom change while the row stayed flagged as having an offer applied.
			reapplyItemPriceOffer(item, context);
		} else {
			// For regular items, use standard conversion
			if (item.batch_price) {
				item.base_rate = item.batch_price * item.conversion_factor;
				item.base_price_list_rate = item.base_rate;
			} else if (item.original_base_rate) {
				item.base_rate = item.original_base_rate * item.conversion_factor;
				item.base_price_list_rate = item.original_base_price_list_rate * item.conversion_factor;
			}

			// Convert to selected currency
			const baseCurrency = context.price_list_currency || context.pos_profile.currency;
			if (context.selected_currency !== baseCurrency) {
				item.rate = context.flt(item.base_rate / context.exchange_rate, context.currency_precision);
				item.price_list_rate = context.flt(
					item.base_price_list_rate / context.exchange_rate,
					context.currency_precision,
				);
			} else {
				item.rate = item.base_rate;
				item.price_list_rate = item.base_price_list_rate;
			}
		}

		// Update item details
		if (context.calc_stock_qty) context.calc_stock_qty(item, item.qty);
		if (context.forceUpdate) context.forceUpdate();
	};

	// Calculate stock quantity for an item
	const calcStockQty = (item, value) => {
		item.stock_qty = item.conversion_factor * value;
	};

	return {
		calcUom,
		calcStockQty,
	};
}
