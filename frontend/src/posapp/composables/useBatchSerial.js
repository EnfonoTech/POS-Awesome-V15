import { ref } from "vue";

export function useBatchSerial() {
	// Set serial numbers for an item (and update qty)
	const setSerialNo = (item, forceUpdate) => {
		console.log(item);
		if (!item.has_serial_no) return;
		item.serial_no = "";
		item.serial_no_selected.forEach((element) => {
			item.serial_no += element + "\n";
		});
		item.serial_no_selected_count = item.serial_no_selected.length;
		if (item.serial_no_selected_count != item.stock_qty) {
			item.qty = item.serial_no_selected_count;
			// Note: calc_stock_qty would need to be passed as a parameter or imported
			if (forceUpdate) forceUpdate();
		}
	};

	// Set batch number for an item (and update batch data)
	const setBatchQty = (item, value, update = true, context) => {
		console.log("Setting batch quantity:", item, value);
		
		// Guard against missing context or items
		if (!context || !context.items || !Array.isArray(context.items)) {
			if (value && item) {
				item.batch_no = value;
			}
			return;
		}
		
		// If item doesn't have batch_no_data, return early (item might not have batch data loaded yet)
		// This can happen when loading invoices from backend before batch data is fetched
		if (!item || !item.has_batch_no) {
			return;
		}
		
		// If batch_no_data is not available yet, just set the batch_no value if provided
		// The batch data will be loaded later via update_items_details
		if (!item.batch_no_data || !Array.isArray(item.batch_no_data) || item.batch_no_data.length === 0) {
			if (value) {
				item.batch_no = value;
			}
			return;
		}
		
		const existing_items = context.items.filter(
			(element) => element.item_code == item.item_code && element.posa_row_id != item.posa_row_id,
		);
		const used_batches = {};
		
		// Double-check batch_no_data is valid before iterating
		if (!item.batch_no_data || !Array.isArray(item.batch_no_data)) {
			if (value) {
				item.batch_no = value;
			}
			return;
		}
		
		item.batch_no_data.forEach((batch) => {
			if (!batch || !batch.batch_no) return; // Skip invalid batch entries
			used_batches[batch.batch_no] = {
				...batch,
				used_qty: 0,
				remaining_qty: batch.batch_qty || 0,
			};
			if (Array.isArray(existing_items)) {
				existing_items.forEach((element) => {
					if (element && element.batch_no && element.batch_no == batch.batch_no) {
						used_batches[batch.batch_no].used_qty += element.qty || 0;
						used_batches[batch.batch_no].remaining_qty -= element.qty || 0;
						used_batches[batch.batch_no].batch_qty -= element.qty || 0;
					}
				});
			}
		});

		const batch_no_data = Object.values(used_batches)
			.filter((batch) => batch.remaining_qty > 0)
			.sort((a, b) => {
				if (a.expiry_date && b.expiry_date) {
					return new Date(a.expiry_date) - new Date(b.expiry_date);
				} else if (a.expiry_date) {
					return -1;
				} else if (b.expiry_date) {
					return 1;
				} else if (a.manufacturing_date && b.manufacturing_date) {
					return new Date(a.manufacturing_date) - new Date(b.manufacturing_date);
				} else if (a.manufacturing_date) {
					return -1;
				} else if (b.manufacturing_date) {
					return 1;
				} else {
					return b.remaining_qty - a.remaining_qty;
				}
			});

		if (batch_no_data.length > 0) {
			let batch_to_use = null;
			if (value) {
				batch_to_use = batch_no_data.find((batch) => batch.batch_no == value);
			}
			if (!batch_to_use) {
				batch_to_use = batch_no_data[0];
			}

			item.batch_no = batch_to_use.batch_no;
			item.actual_batch_qty = batch_to_use.batch_qty;
			item.batch_no_expiry_date = batch_to_use.expiry_date;
			
			// Force UI update to ensure autocomplete displays the batch number
			if (context && context.$nextTick) {
				context.$nextTick(() => {
					if (context.$forceUpdate) {
						context.$forceUpdate();
					}
				});
			}

			if (batch_to_use.batch_price) {
				// Store batch price in base currency
				item.base_batch_price = batch_to_use.batch_price;

				// Convert batch price to selected currency if needed
				const baseCurrency = context.price_list_currency || context.pos_profile.currency;
				if (context.selected_currency !== baseCurrency) {
					item.batch_price = context.flt(
						batch_to_use.batch_price / context.exchange_rate,
						context.currency_precision,
					);
				} else {
					item.batch_price = batch_to_use.batch_price;
				}

				// Set rates based on batch price
				item.base_price_list_rate = item.base_batch_price;
				item.base_rate = item.base_batch_price;

				if (context.selected_currency !== baseCurrency) {
					item.price_list_rate = item.batch_price;
					item.rate = item.batch_price;
				} else {
					item.price_list_rate = item.base_batch_price;
					item.rate = item.base_batch_price;
				}

				// Reset discounts since we're using batch price
				item.discount_percentage = 0;
				item.discount_amount = 0;
				item.base_discount_amount = 0;

				// Calculate final amounts
				item.amount = context.flt(item.qty * item.rate, context.currency_precision);
				item.base_amount = context.flt(item.qty * item.base_rate, context.currency_precision);

				console.log("Updated batch prices:", {
					base_batch_price: item.base_batch_price,
					batch_price: item.batch_price,
					rate: item.rate,
					base_rate: item.base_rate,
					price_list_rate: item.price_list_rate,
					exchange_rate: context.exchange_rate,
				});
			} else if (update && context.update_item_detail) {
				item.batch_price = null;
				item.base_batch_price = null;
				context.update_item_detail(item);
			}
		} else {
			item.batch_no = null;
			item.actual_batch_qty = null;
			item.batch_no_expiry_date = null;
			item.batch_price = null;
			item.base_batch_price = null;
		}

		// Update batch_no_data
		item.batch_no_data = batch_no_data;

		// Force UI update
		if (context.forceUpdate) context.forceUpdate();
	};

	return {
		setSerialNo,
		setBatchQty,
	};
}
