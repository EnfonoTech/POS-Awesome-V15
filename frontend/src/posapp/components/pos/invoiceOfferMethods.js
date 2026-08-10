import { silentPrint } from "../../plugins/print.js";
import { isOffline } from "../../../offline/index.js";
import { formatUtils } from "../../format.js";
/* global __, frappe, flt */

export default {
	scheduleOfferRefresh(changedRowIds = []) {
		if (this.isApplyingOffer) {
			return;
		}

		this._pendingOfferRowIds = this._pendingOfferRowIds || new Set();
		if (Array.isArray(changedRowIds)) {
			changedRowIds.forEach((rowId) => {
				if (rowId) {
					this._pendingOfferRowIds.add(rowId);
				}
			});
		}

		if (this._offerRefreshPending) {
			return;
		}

		this._offerRefreshPending = true;

		const schedule =
			typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
				? window.requestAnimationFrame.bind(window)
				: (cb) => setTimeout(cb, 16);

		this._offerRefreshHandle = schedule(() => {
			this._offerRefreshHandle = null;
			this._offerRefreshPending = false;

			if (this.isApplyingOffer) {
				return;
			}

			const pendingRows = this._pendingOfferRowIds ? Array.from(this._pendingOfferRowIds) : [];
			this._pendingOfferRowIds = new Set();
			const removedRows = this._pendingRemovedRowInfo || {};
			this._pendingRemovedRowInfo = {};

			this.handelOffers(pendingRows, removedRows);

			if (typeof this.$forceUpdate === "function") {
				this.$forceUpdate();
			}
		});
	},
	cancelScheduledOfferRefresh() {
		if (this._offerRefreshHandle != null) {
			if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
				window.cancelAnimationFrame(this._offerRefreshHandle);
			} else {
				clearTimeout(this._offerRefreshHandle);
			}
			this._offerRefreshHandle = null;
		}

		this._offerRefreshPending = false;
		this._pendingOfferRowIds = new Set();
		this._pendingRemovedRowInfo = {};
	},
	normalizeBrand(brand) {
		return (brand || "").trim().toLowerCase();
	},
	async getItemBrand(item) {
		let brand = this.normalizeBrand(item.brand);
		if (brand) {
			item.brand = brand;
			return brand;
		}

		this.brand_cache = this.brand_cache || {};

		if (this.brand_cache[item.item_code]) {
			brand = this.brand_cache[item.item_code];
		} else {
			try {
				const { message } = await frappe.call({
					method: "posawesome.posawesome.api.items.get_item_brand",
					args: { item_code: item.item_code },
				});
				brand = this.normalizeBrand(message);
			} catch (error) {
				console.error("Failed to fetch item brand:", error);
				brand = "";
			}

			this.brand_cache[item.item_code] = brand;
		}

		item.brand = brand;
		return brand;
	},
	checkOfferIsAppley(item, offer) {
		let applied = false;
		const item_offers = JSON.parse(item.posa_offers);
		for (const row_id of item_offers) {
			const exist_offer = this.posa_offers.find((el) => row_id == el.row_id);
			if (exist_offer && exist_offer.offer_name == offer.name) {
				applied = true;
				break;
			}
		}
		return applied;
	},

	async handelOffers(changedRowIds = [], removedRows = {}) {
		try {
			const sourceOffers = Array.isArray(this.posOffers) ? this.posOffers : [];
			if (!sourceOffers.length) {
				this.updatePosOffers([]);
				this._cachedOfferResults = new Map();
				return;
			}

			const allItems = [...(this.items || []), ...(this.packed_items || [])];
			const itemMap = new Map();
			allItems.forEach((item) => {
				if (item && item.posa_row_id) {
					itemMap.set(item.posa_row_id, item);
				}
			});

			const changedSet = new Set((Array.isArray(changedRowIds) ? changedRowIds : []).filter(Boolean));
			const removedInfo = removedRows || {};

			this._cachedOfferResults =
				this._cachedOfferResults instanceof Map ? this._cachedOfferResults : new Map();
			const cache = this._cachedOfferResults;

			const offerNames = new Set(sourceOffers.map((offer) => offer.name));
			for (const cachedName of Array.from(cache.keys())) {
				if (!offerNames.has(cachedName)) {
					cache.delete(cachedName);
				}
			}

			const offersToRecompute =
				!changedSet.size && !Object.keys(removedInfo).length
					? sourceOffers
					: sourceOffers.filter((offer) =>
							this.isOfferAffected(offer, changedSet, itemMap, removedInfo),
						);

			let context = null;
			if (offersToRecompute.length) {
				context = await this.buildOfferEvaluationContext(allItems, offersToRecompute);
				context.itemMap = itemMap;
			} else {
				context = { itemMap };
			}

			for (const offer of offersToRecompute) {
				const evaluated = this.evaluateOffer(offer, context);
				if (evaluated) {
					cache.set(offer.name, evaluated);
				} else {
					cache.delete(offer.name);
				}
			}

			const offers = sourceOffers.map((offer) => cache.get(offer.name)).filter((entry) => !!entry);

			this.setItemGiveOffer(offers);
			this.updatePosOffers(offers);
		} catch (error) {
			console.error("Failed to process offers:", error);
		}
	},

	isOfferAffected(offer, changedSet, itemMap, removedInfo = {}) {
		if (!offer) {
			return false;
		}

		if (!changedSet || !changedSet.size) {
			return true;
		}

		const applyOn = offer.apply_on;
		const normalizedBrand = applyOn === "Brand" ? this.normalizeBrand(offer.brand) : null;

		for (const rowId of changedSet) {
			const item = itemMap.get(rowId);
			const fallback = removedInfo[rowId];
			const meta = item
				? {
						item_code: item.item_code,
						item_group: item.item_group,
						brand: this.normalizeBrand(
							item.brand || (this.brand_cache && this.brand_cache[item.item_code]) || "",
						),
					}
				: fallback
					? {
							item_code: fallback.item_code,
							item_group: fallback.item_group,
							brand: this.normalizeBrand(
								fallback.brand ||
									(this.brand_cache && this.brand_cache[fallback.item_code]) ||
									"",
							),
						}
					: null;

			if (!meta) {
				return true;
			}

			switch (applyOn) {
				case "Item Code":
					if (meta.item_code === offer.item) {
						return true;
					}
					break;
				case "Item Group":
					if (meta.item_group === offer.item_group) {
						return true;
					}
					break;
				case "Brand":
					if (!normalizedBrand) {
						return true;
					}
					if (!meta.brand) {
						return true;
					}
					if (meta.brand === normalizedBrand) {
						return true;
					}
					break;
				case "Transaction":
					return true;
				case "Item Combination": {
					const comboItems = this.parseComboItems(offer.combo_items);
					if (comboItems.some((combo) => combo.item_code === meta.item_code)) {
						return true;
					}
					break;
				}
				default:
					break;
			}
		}

		return false;
	},

	parseComboItems(comboItems) {
		if (Array.isArray(comboItems)) {
			return comboItems;
		}
		if (typeof comboItems === "string" && comboItems) {
			try {
				const parsed = JSON.parse(comboItems);
				return Array.isArray(parsed) ? parsed : [];
			} catch (error) {
				console.warn("Failed to parse combo items", error);
				return [];
			}
		}
		return [];
	},

	async buildOfferEvaluationContext(allItems, offers) {
		const context = {
			itemMap: new Map(),
			itemCodeBuckets: new Map(),
			itemGroupBuckets: new Map(),
			brandBuckets: new Map(),
			transactionBucket: { items: [], qty: 0, amount: 0 },
		};

		const needItemCode = offers.some(
			(offer) => offer.apply_on === "Item Code" || offer.apply_on === "Item Combination",
		);
		const needGroup = offers.some((offer) => offer.apply_on === "Item Group");
		const needBrand = offers.some((offer) => offer.apply_on === "Brand");
		const needTransaction = offers.some((offer) => offer.apply_on === "Transaction");

		const brandCandidates = [];

		(Array.isArray(allItems) ? allItems : []).forEach((item) => {
			if (!item) {
				return;
			}
			if (item.posa_row_id) {
				context.itemMap.set(item.posa_row_id, item);
			}

			const qty = item.stock_qty || 0;
			// `qty` here is stock_qty (uom-normalized), so `rate` must be a per-stock-unit
			// price to keep `amount = qty * rate` correct -- original_price_list_rate already
			// is (it's snapshotted as price_list_rate / conversion_factor, see ApplyOnCombo/
			// toggleOffer), but price_list_rate itself is scaled to the row's CURRENT sold
			// uom (calcUom multiplies it by conversion_factor), so it must be divided back
			// down before use, or a row sold as "1 Box" (conversion_factor 3) would price
			// its bucket contribution 3x too high before any offer snapshot exists yet.
			const rate = item.original_price_list_rate ?? flt(item.price_list_rate || 0) / (flt(item.conversion_factor) || 1);
			const amount = qty * rate;

			if (needItemCode && !item.posa_is_offer && item.item_code) {
				let bucket = context.itemCodeBuckets.get(item.item_code);
				if (!bucket) {
					bucket = { items: [], qty: 0, amount: 0 };
					context.itemCodeBuckets.set(item.item_code, bucket);
				}
				bucket.items.push(item);
				bucket.qty += qty;
				bucket.amount += amount;
			}

			if (needGroup && !item.posa_is_offer && item.item_group) {
				let bucket = context.itemGroupBuckets.get(item.item_group);
				if (!bucket) {
					bucket = { items: [], qty: 0, amount: 0 };
					context.itemGroupBuckets.set(item.item_group, bucket);
				}
				bucket.items.push(item);
				bucket.qty += qty;
				bucket.amount += amount;
			}

			if (needBrand && !item.posa_is_offer && item.item_code) {
				brandCandidates.push(item);
			}

			if (needTransaction && !item.posa_is_offer && !item.posa_is_replace) {
				context.transactionBucket.items.push(item);
				context.transactionBucket.qty += qty;
				context.transactionBucket.amount += amount;
			}
		});

		if (needBrand) {
			for (const item of brandCandidates) {
				const brand = await this.getItemBrand(item);
				if (!brand) {
					continue;
				}
				let bucket = context.brandBuckets.get(brand);
				if (!bucket) {
					bucket = { items: [], qty: 0, amount: 0 };
					context.brandBuckets.set(brand, bucket);
				}
				bucket.items.push(item);
				bucket.qty += item.stock_qty || 0;
				// per-stock-unit rate -- see the comment on this same expression in buildOfferEvaluationContext
			const rate = item.original_price_list_rate ?? flt(item.price_list_rate || 0) / (flt(item.conversion_factor) || 1);
				bucket.amount += (item.stock_qty || 0) * rate;
			}
		}

		return context;
	},

	evaluateOffer(offer, context = {}) {
		if (!offer) {
			return null;
		}

		if (offer.apply_on === "Item Code") {
			return this.getItemOffer({ ...offer }, context);
		}
		if (offer.apply_on === "Item Group") {
			return this.getGroupOffer({ ...offer }, context);
		}
		if (offer.apply_on === "Brand") {
			return this.getBrandOffer({ ...offer }, context);
		}
		if (offer.apply_on === "Transaction") {
			return this.getTransactionOffer({ ...offer }, context);
		}
		if (offer.apply_on === "Item Combination") {
			return this.getComboOffer({ ...offer }, context);
		}
		return null;
	},

	setItemGiveOffer(offers) {
		// Set item give offer for replace
		offers.forEach((offer) => {
			if (offer.apply_on == "Item Code" && offer.apply_type == "Item Code" && offer.replace_item) {
				offer.give_item = offer.item;
				offer.apply_item_code = offer.item;
			} else if (
				offer.apply_on == "Item Group" &&
				offer.apply_type == "Item Group" &&
				offer.replace_cheapest_item
			) {
				const offerItemCode = this.getCheapestItem(offer).item_code;
				offer.give_item = offerItemCode;
				offer.apply_item_code = offerItemCode;
			}
		});
	},

	getCheapestItem(offer) {
		let itemsRowID;
		if (typeof offer.items === "string") {
			itemsRowID = JSON.parse(offer.items);
		} else {
			itemsRowID = offer.items;
		}
		const itemsList = [];
		itemsRowID.forEach((row_id) => {
			itemsList.push(this.getItemFromRowID(row_id));
		});
		const result = itemsList.reduce(function (res, obj) {
			return !obj.posa_is_replace && !obj.posa_is_offer && obj.price_list_rate < res.price_list_rate
				? obj
				: res;
		});
		return result;
	},

	getItemFromRowID(row_id) {
		const combined = [...this.items, ...this.packed_items];
		return combined.find((el) => el.posa_row_id == row_id);
	},

	checkQtyAnountOffer(offer, qty, amount) {
		let min_qty = false;
		let max_qty = false;
		let min_amt = false;
		let max_amt = false;
		const applys = [];

		if (offer.min_qty || offer.min_qty == 0) {
			if (qty >= offer.min_qty) {
				min_qty = true;
			}
			applys.push(min_qty);
		}

		if (offer.max_qty > 0) {
			if (qty <= offer.max_qty) {
				max_qty = true;
			}
			applys.push(max_qty);
		}

		if (offer.min_amt > 0) {
			if (amount >= offer.min_amt) {
				min_amt = true;
			}
			applys.push(min_amt);
		}

		if (offer.max_amt > 0) {
			if (amount <= offer.max_amt) {
				max_amt = true;
			}
			applys.push(max_amt);
		}
		let apply = false;
		if (!applys.includes(false)) {
			apply = true;
		}
		const res = {
			apply: apply,
			conditions: { min_qty, max_qty, min_amt, max_amt },
		};
		return res;
	},

	checkOfferCoupon(offer) {
		if (offer.coupon_based) {
			const coupon = this.posa_coupons.find((el) => offer.name == el.pos_offer);
			if (coupon) {
				offer.coupon = coupon.coupon;
				return true;
			} else {
				return false;
			}
		} else {
			offer.coupon = null;
			return true;
		}
	},

	getItemOffer(offer, context = {}) {
		if (!offer || offer.apply_on !== "Item Code") {
			return null;
		}

		if (!this.checkOfferCoupon(offer)) {
			return null;
		}

		const bucket = context.itemCodeBuckets ? context.itemCodeBuckets.get(offer.item) : null;
		if (!bucket) {
			return null;
		}

		const items = [];
		let totalQty = 0;
		let totalAmount = 0;

		bucket.items.forEach((item) => {
			if (!item || item.posa_is_offer) {
				return;
			}
			if (
				offer.offer === "Item Price" &&
				item.posa_offer_applied &&
				!this.checkOfferIsAppley(item, offer)
			) {
				return;
			}
			const qty = item.stock_qty || 0;
			// per-stock-unit rate -- see the comment on this same expression in buildOfferEvaluationContext
			const rate = item.original_price_list_rate ?? flt(item.price_list_rate || 0) / (flt(item.conversion_factor) || 1);
			totalQty += qty;
			totalAmount += qty * rate;
			items.push(item.posa_row_id);
		});

		if (!totalQty && !totalAmount) {
			return null;
		}

		const res = this.checkQtyAnountOffer(offer, totalQty, totalAmount);
		if (!res.apply) {
			return null;
		}

		offer.items = items;
		return offer;
	},

	getGroupOffer(offer, context = {}) {
		if (!offer || offer.apply_on !== "Item Group") {
			return null;
		}

		if (!this.checkOfferCoupon(offer)) {
			return null;
		}

		const bucket = context.itemGroupBuckets ? context.itemGroupBuckets.get(offer.item_group) : null;
		if (!bucket) {
			return null;
		}

		const items = [];
		let totalQty = 0;
		let totalAmount = 0;

		bucket.items.forEach((item) => {
			if (!item || item.posa_is_offer) {
				return;
			}
			if (
				offer.offer === "Item Price" &&
				item.posa_offer_applied &&
				!this.checkOfferIsAppley(item, offer)
			) {
				return;
			}
			const qty = item.stock_qty || 0;
			// per-stock-unit rate -- see the comment on this same expression in buildOfferEvaluationContext
			const rate = item.original_price_list_rate ?? flt(item.price_list_rate || 0) / (flt(item.conversion_factor) || 1);
			totalQty += qty;
			totalAmount += qty * rate;
			items.push(item.posa_row_id);
		});

		if (!totalQty && !totalAmount) {
			return null;
		}

		const res = this.checkQtyAnountOffer(offer, totalQty, totalAmount);
		if (!res.apply) {
			return null;
		}

		offer.items = items;
		return offer;
	},

	getBrandOffer(offer, context = {}) {
		if (!offer || offer.apply_on !== "Brand") {
			return null;
		}

		if (!this.checkOfferCoupon(offer)) {
			return null;
		}

		const normalizedBrand = this.normalizeBrand(offer.brand);
		if (!normalizedBrand) {
			return null;
		}

		const bucket = context.brandBuckets ? context.brandBuckets.get(normalizedBrand) : null;
		if (!bucket) {
			return null;
		}

		const items = [];
		let totalQty = 0;
		let totalAmount = 0;

		bucket.items.forEach((item) => {
			if (!item || item.posa_is_offer) {
				return;
			}
			if (
				offer.offer === "Item Price" &&
				item.posa_offer_applied &&
				!this.checkOfferIsAppley(item, offer)
			) {
				return;
			}
			const qty = item.stock_qty || 0;
			// per-stock-unit rate -- see the comment on this same expression in buildOfferEvaluationContext
			const rate = item.original_price_list_rate ?? flt(item.price_list_rate || 0) / (flt(item.conversion_factor) || 1);
			totalQty += qty;
			totalAmount += qty * rate;
			items.push(item.posa_row_id);
		});

		if (!totalQty && !totalAmount) {
			return null;
		}

		const res = this.checkQtyAnountOffer(offer, totalQty, totalAmount);
		if (!res.apply) {
			return null;
		}

		offer.items = items;
		return offer;
	},
	getTransactionOffer(offer, context = {}) {
		if (!offer || offer.apply_on !== "Transaction") {
			return null;
		}

		if (!this.checkOfferCoupon(offer)) {
			return null;
		}

		const bucket = context.transactionBucket || { items: [], qty: 0, amount: 0 };
		if (!bucket.items.length && !bucket.qty && !bucket.amount) {
			return null;
		}

		const res = this.checkQtyAnountOffer(offer, bucket.qty, bucket.amount);
		if (!res.apply) {
			return null;
		}

		offer.items = bucket.items.map((item) => item.posa_row_id);
		return offer;
	},

	getComboOffer(offer, context = {}) {
		if (!offer || offer.apply_on !== "Item Combination") {
			return null;
		}

		if (!this.checkOfferCoupon(offer)) {
			return null;
		}

		const comboItems = this.parseComboItems(offer.combo_items);
		if (comboItems.length < 2) {
			return null;
		}

		// First pass: gather each combo item's full cart quantity/amount/rows and work out
		// how many complete sets the combo as a whole can support (limited by whichever
		// item is scarcest).
		const perItemData = [];
		let instances = Infinity;

		for (const combo of comboItems) {
			const bucket = context.itemCodeBuckets ? context.itemCodeBuckets.get(combo.item_code) : null;
			if (!bucket) {
				return null;
			}

			const rows = [];
			let qty = 0;
			let amount = 0;

			bucket.items.forEach((item) => {
				if (!item || item.posa_is_offer) {
					return;
				}
				// Exclude rows already claimed by a DIFFERENT Item Price offer -- but rows
				// this SAME combo offer already discounted must stay counted, or the very act
				// of applying it flips item.posa_offer_applied to 1 and makes the next
				// evaluation pass exclude its own rows, un-qualify, get removed, and
				// immediately re-qualify/re-apply from scratch -- an endless apply/remove
				// oscillation that (since nothing about the cart changed) keeps landing on the
				// same rate and looks to the user like a permanently frozen one.
				//
				// A first attempt at this check compared item.posa_offers (a list of row_ids)
				// against `offer.row_id` -- but `offer` here is evaluateOffer's shallow copy of
				// this.posOffers' RAW template, which never has a row_id at all (that's a
				// frontend-only id PosOffers.vue invents later, once an offer is first tracked;
				// confirmed via the backend get_offers() source, which has no such field). That
				// made the comparison always false, i.e. always "someone else's", i.e. always
				// excluded -- worse than the original bug.
				//
				// Fixed to check the opposite direction and default the other way: only exclude
				// when this.posa_offers (Invoice-level bookkeeping, keyed by row_id -> offer
				// name) POSITIVELY shows a DIFFERENT offer's name against one of this item's
				// claimed row_ids. If that lookup can't find anything yet -- e.g. this.posa_offers
				// hasn't caught up with a just-applied discount, the exact race that caused the
				// oscillation -- there is nothing to prove a competing claim, so default to NOT
				// excluding rather than assuming the worst.
				if (offer.offer === "Item Price" && item.posa_offer_applied) {
					let claimedByDifferentOffer = false;
					try {
						const parsed = item.posa_offers ? JSON.parse(item.posa_offers) : [];
						if (Array.isArray(parsed)) {
							claimedByDifferentOffer = parsed.some((row_id) => {
								const tracked = (this.posa_offers || []).find((el) => el.row_id === row_id);
								return !!(tracked && tracked.offer_name && tracked.offer_name !== offer.name);
							});
						}
					} catch (error) {
						claimedByDifferentOffer = false;
					}
					if (claimedByDifferentOffer) {
						return;
					}
				}
				const itemQty = item.stock_qty || 0;
				// per-stock-unit rate -- see the comment on this same expression in buildOfferEvaluationContext
			const rate = item.original_price_list_rate ?? flt(item.price_list_rate || 0) / (flt(item.conversion_factor) || 1);
				const itemAmount = itemQty * rate;
				qty += itemQty;
				amount += itemAmount;
				rows.push({ row_id: item.posa_row_id, qty: item.qty || 0, amount: itemAmount });
			});

			// combo.qty is defined in the combo item's own uom (e.g. "1 Box"), while `qty`
			// summed above is in stock_qty terms (bucket.qty aggregates item.stock_qty).
			// Convert the requirement into the same stock-uom terms via the item's
			// conversion_factor for that uom (attached server-side by _attach_combo_items)
			// before comparing -- otherwise "1 Box" (== 3 Nos) would incorrectly require
			// only 1 loose Nos to qualify.
			const requiredQty = (flt(combo.qty) || 1) * (flt(combo.conversion_factor) || 1);
			if (qty < requiredQty || !amount) {
				return null;
			}

			// How many complete combo sets can this item support on its own -- the
			// combo as a whole can only qualify for as many sets as its scarcest item.
			instances = Math.min(instances, Math.floor(qty / requiredQty));

			perItemData.push({ item_code: combo.item_code, requiredQty, qty, amount, rows });
		}

		if (!(instances >= 1)) {
			return null;
		}

		// Second pass: the amount actually "used" by the qualifying sets (required qty x
		// instances, at this item's own average rate) -- NOT its full cart amount. This is
		// what the discount gets split across between DIFFERENT combo items, so buying more
		// of item A than the current instances need doesn't change item B's share at all.
		// Any leftover quantity of an item beyond what instances need still shares in ITS
		// OWN item's discount below (divided across item.qty), just without rippling into
		// other items' rates.
		const breakdown = [];
		let totalAmount = 0;

		for (const data of perItemData) {
			const avgRate = data.amount / data.qty;
			const usedAmount = data.requiredQty * instances * avgRate;
			breakdown.push({ item_code: data.item_code, amount: data.amount, usedAmount, rows: data.rows });
			totalAmount += usedAmount;
		}

		if (!totalAmount) {
			return null;
		}

		offer.items = breakdown.flatMap((entry) => entry.rows.map((row) => row.row_id));
		offer.combo_breakdown = breakdown;
		offer.combo_total_amount = totalAmount;
		offer.combo_instances = instances;

		// Give Product: scale the given quantity by how many complete sets qualify
		// (buy enough for 2 sets, get 2x the free item) rather than always giving
		// exactly one regardless of how many sets are in the cart.
		if (offer.offer === "Give Product") {
			offer.given_qty = this.flt(flt(offer.given_qty) * instances, this.currency_precision);
		}

		return offer;
	},

	updatePosOffers(offers) {
		this.eventBus.emit("update_pos_offers", offers);
	},

	updateInvoiceOffers(offers) {
		this.posa_offers.forEach((invoiceOffer) => {
			const existOffer = offers.find((offer) => invoiceOffer.row_id == offer.row_id);
			if (!existOffer) {
				this.removeApplyOffer(invoiceOffer);
			}
		});
		offers.forEach((offer) => {
			const existOffer = this.posa_offers.find((invoiceOffer) => invoiceOffer.row_id == offer.row_id);
			if (existOffer) {
				existOffer.items = JSON.stringify(offer.items);
                                if (
                                        existOffer.offer === "Give Product" &&
                                        existOffer.give_item &&
                                        existOffer.give_item != offer.give_item
                                ) {
                                        const combined = [...this.items, ...this.packed_items];
                                        const item_to_remove = combined.find(
                                                (item) => item.posa_row_id == existOffer.give_item_row_id,
                                        );

                                        const newItemOffer = this.ApplyOnGiveProduct(offer);

                                        if (!newItemOffer) {
                                                offer.give_item = existOffer.give_item;
                                                offer.give_item_row_id = existOffer.give_item_row_id;
                                                return;
                                        }

                                        if (!item_to_remove) {
                                                this.notifyOfferItemUnavailable(existOffer.give_item);
                                                return;
                                        }

                                        let updated_item_offers = [];
                                        if (Array.isArray(offer.items)) {
                                                updated_item_offers = offer.items.filter(
                                                        (row_id) => row_id != item_to_remove.posa_row_id,
                                                );
                                        } else if (typeof offer.items === "string") {
                                                try {
                                                        const parsed = JSON.parse(offer.items);
                                                        if (Array.isArray(parsed)) {
                                                                updated_item_offers = parsed.filter(
                                                                        (row_id) => row_id != item_to_remove.posa_row_id,
                                                                );
                                                        }
                                                } catch (error) {
                                                        console.warn("Failed to parse offer items for update", error);
                                                }
                                        }
                                        offer.items = updated_item_offers;

                                        const collection = this.items.includes(item_to_remove)
                                                ? this.items
                                                : this.packed_items;
                                        const idx = collection.findIndex(
                                                (el) => el.posa_row_id == item_to_remove.posa_row_id,
                                        );
                                        if (idx > -1) collection.splice(idx, 1);

                                        existOffer.give_item_row_id = null;
                                        existOffer.give_item = null;

                                        if (offer.replace_cheapest_item) {
                                                const cheapestItem = this.getCheapestItem(offer);
                                                if (!cheapestItem) {
                                                        this.notifyOfferItemUnavailable(offer.give_item);
                                                        return;
                                                }
                                                const oldBaseItem = combined.find(
                                                        (el) => el.posa_row_id == item_to_remove.posa_is_replace,
                                                );
                                                newItemOffer.qty = item_to_remove.qty;
                                                if (oldBaseItem && !oldBaseItem.posa_is_replace) {
                                                        oldBaseItem.qty += item_to_remove.qty;
                                                } else {
                                                        const restoredItem = this.ApplyOnGiveProduct(
                                                                {
                                                                        given_qty: item_to_remove.qty,
                                                                },
                                                                item_to_remove.item_code,
                                                        );
                                                        if (restoredItem) {
                                                                restoredItem.posa_is_offer = 0;
                                                                this.items.unshift(restoredItem);
                                                        }
                                                }
                                                newItemOffer.posa_is_offer = 0;
                                                newItemOffer.posa_is_replace = cheapestItem.posa_row_id;
                                                const diffQty = cheapestItem.qty - newItemOffer.qty;
                                                if (diffQty <= 0) {
                                                        newItemOffer.qty += diffQty;
                                                        const baseCollection = this.items.includes(cheapestItem)
                                                                ? this.items
                                                                : this.packed_items;
                                                        const baseIndex = baseCollection.findIndex(
                                                                (el) => el.posa_row_id == cheapestItem.posa_row_id,
                                                        );
                                                        if (baseIndex > -1) baseCollection.splice(baseIndex, 1);
                                                        newItemOffer.posa_row_id = cheapestItem.posa_row_id;
                                                        newItemOffer.posa_is_replace = newItemOffer.posa_row_id;
                                                } else {
                                                        cheapestItem.qty = diffQty;
                                                }
                                        }

                                        this.items.unshift(newItemOffer);
                                        existOffer.give_item_row_id = newItemOffer.posa_row_id;
                                        existOffer.give_item = newItemOffer.item_code;
                                } else if (
                                        existOffer.offer === "Give Product" &&
                                        existOffer.give_item &&
					existOffer.give_item == offer.give_item &&
					(offer.replace_item || offer.replace_cheapest_item)
				) {
                                        this.$nextTick(function () {
                                                const offerItem = this.getItemFromRowID(existOffer.give_item_row_id);
                                                if (!offerItem) {
                                                        return;
                                                }

                                                const diff = offer.given_qty - (offerItem.qty || 0);
                                                if (diff <= 0) {
                                                        return;
                                                }

                                                let itemsRowID = [];
                                                try {
                                                        const parsed = JSON.parse(existOffer.items);
                                                        if (Array.isArray(parsed)) {
                                                                itemsRowID = parsed;
                                                        }
                                                } catch (error) {
                                                        console.warn("Failed to parse offer items", error);
                                                        itemsRowID = [];
                                                }

                                                if (!itemsRowID.length) {
                                                        return;
                                                }

                                                const itemsList = [];
                                                itemsRowID.forEach((row_id) => {
                                                        const resolved = this.getItemFromRowID(row_id);
                                                        if (resolved) {
                                                                itemsList.push(resolved);
                                                        }
                                                });

                                                const existItem = itemsList.find(
                                                        (el) =>
                                                                el &&
                                                                el.item_code == offerItem.item_code &&
                                                                el.posa_is_replace != offerItem.posa_row_id,
                                                );
                                                if (!existItem) {
                                                        return;
                                                }

                                                const diffExistQty = existItem.qty - diff;
                                                if (diffExistQty > 0) {
                                                        offerItem.qty += diff;
                                                        existItem.qty -= diff;
                                                } else {
                                                        offerItem.qty += existItem.qty;
                                                        const col = this.items.includes(existItem)
                                                                ? this.items
                                                                : this.packed_items;
                                                        const idx2 = col.findIndex(
                                                                (el) => el.posa_row_id == existItem.posa_row_id,
                                                        );
                                                        if (idx2 > -1) col.splice(idx2, 1);
                                                }
                                        });
                                } else if (existOffer.offer === "Give Product" && offer.apply_on === "Item Combination") {
                                        // Combo Give Product never sets replace_item/replace_cheapest_item, so
                                        // neither branch above ever runs for it -- handle its own quantity
                                        // top-up/down here instead: the number of qualifying combo sets (and
                                        // therefore offer.given_qty, scaled in getComboOffer) can change on any
                                        // later evaluation pass as the cart changes.
                                        const givenItem = this.getItemFromRowID(existOffer.give_item_row_id);
                                        const desiredQty = flt(offer.given_qty);
                                        if (givenItem && desiredQty > 0 && flt(givenItem.qty) !== desiredQty) {
                                                givenItem.qty = desiredQty;
                                                givenItem.stock_qty = desiredQty;
                                                givenItem.amount = this.flt(
                                                        givenItem.qty * givenItem.rate,
                                                        this.currency_precision,
                                                );
                                                givenItem.base_amount = this.flt(
                                                        givenItem.qty * givenItem.base_rate,
                                                        this.currency_precision,
                                                );
                                        }
                                        // Same reasoning as the other reuse path in _applyNewOfferBody: this
                                        // qty top-up never fetches item detail, so a row stuck with no real
                                        // price_list_rate would otherwise never get another chance.
                                        if (givenItem && !givenItem.price_list_rate) {
                                                this.update_item_detail(givenItem, true);
                                        }
                                } else if (existOffer.offer === "Item Price") {
					if (offer.apply_on === "Item Combination") {
						this.ApplyOnCombo(offer);
					} else {
						this.ApplyOnPrice(offer);
					}
				} else if (existOffer.offer === "Grand Total") {
					this.ApplyOnTotal(offer);
				}
				this.addOfferToItems(existOffer);
			} else {
				this.applyNewOffer(offer);
			}
		});
	},

	removeApplyOffer(invoiceOffer) {
		if (invoiceOffer.offer === "Item Price") {
			this.RemoveOnPrice(invoiceOffer);
			const index = this.posa_offers.findIndex((el) => el.row_id === invoiceOffer.row_id);
			this.posa_offers.splice(index, 1);
		}
		if (invoiceOffer.offer === "Give Product") {
			const combined = [...this.items, ...this.packed_items];
			const item_to_remove = combined.find((item) => item.posa_row_id == invoiceOffer.give_item_row_id);
			const index = this.posa_offers.findIndex((el) => el.row_id === invoiceOffer.row_id);
			this.posa_offers.splice(index, 1);
			if (item_to_remove) {
				const collection = this.items.includes(item_to_remove) ? this.items : this.packed_items;
				const idx = collection.findIndex((el) => el.posa_row_id == item_to_remove.posa_row_id);
				if (idx > -1) collection.splice(idx, 1);
			}
		}
		if (invoiceOffer.offer === "Grand Total") {
			this.RemoveOnTotal(invoiceOffer);
			const index = this.posa_offers.findIndex((el) => el.row_id === invoiceOffer.row_id);
			this.posa_offers.splice(index, 1);
		}
		if (invoiceOffer.offer === "Loyalty Point") {
			const index = this.posa_offers.findIndex((el) => el.row_id === invoiceOffer.row_id);
			this.posa_offers.splice(index, 1);
		}
		this.deleteOfferFromItems(invoiceOffer);
	},

	applyNewOffer(offer) {
		this.isApplyingOffer = true;
		try {
			this._applyNewOfferBody(offer);
		} finally {
			// isApplyingOffer gates scheduleOfferRefresh entirely (see its guard at the top
			// of this file) -- if anything in _applyNewOfferBody throws, that guard would
			// otherwise stay stuck true forever, silently disabling ALL future offer
			// re-evaluation for the rest of the session with no visible error.
			this.isApplyingOffer = false;
		}
	},

	_applyNewOfferBody(offer) {
		if (offer.offer === "Item Price") {
			if (offer.apply_on === "Item Combination") {
				this.ApplyOnCombo(offer);
			} else {
				this.ApplyOnPrice(offer);
			}
		}
                if (offer.offer === "Give Product") {
                        let itemsRowID = [];
                        if (typeof offer.items === "string") {
                                try {
                                        const parsed = JSON.parse(offer.items);
                                        if (Array.isArray(parsed)) {
                                                itemsRowID = parsed;
                                        }
                                } catch (error) {
                                        console.warn("Failed to parse offer item rows", error);
                                }
                        } else if (Array.isArray(offer.items)) {
                                itemsRowID = offer.items;
                        }
                        if (offer.apply_on == "Item Code" && offer.apply_type == "Item Code" && offer.replace_item) {
                                const item = this.ApplyOnGiveProduct(offer, offer.item);
                                if (!item) {
                                        return;
                                }
                                const replaceRowId = Array.isArray(itemsRowID) ? itemsRowID[0] : null;
                                if (!replaceRowId) {
                                        return;
                                }
                                item.posa_is_replace = replaceRowId;
                                const combined = [...this.items, ...this.packed_items];
                                const baseItem = combined.find((el) => el && el.posa_row_id == item.posa_is_replace);
                                if (!baseItem) {
                                        return;
                                }
                                const diffQty = baseItem.qty - offer.given_qty;
                                item.posa_is_offer = 0;
                                if (diffQty <= 0) {
                                        item.qty = baseItem.qty;
                                        const collection = this.items.includes(baseItem) ? this.items : this.packed_items;
                                        const idx = collection.findIndex((el) => el.posa_row_id == baseItem.posa_row_id);
                                        if (idx > -1) collection.splice(idx, 1);
                                        item.posa_row_id = item.posa_is_replace;
                                } else {
                                        baseItem.qty = diffQty;
                                }
                                this.items.unshift(item);
                                offer.give_item_row_id = item.posa_row_id;
                        } else if (
                                offer.apply_on == "Item Group" &&
                                offer.apply_type == "Item Group" &&
                                offer.replace_cheapest_item
                        ) {
                                const itemsList = [];
                                itemsRowID.forEach((row_id) => {
                                        const resolved = this.getItemFromRowID(row_id);
                                        if (resolved) {
                                                itemsList.push(resolved);
                                        }
                                });
                                const baseItem = itemsList.find((el) => el && el.item_code == offer.give_item);
                                const item = this.ApplyOnGiveProduct(offer, offer.give_item);
                                if (!item || !baseItem) {
                                        return;
                                }
                                item.posa_is_offer = 0;
                                item.posa_is_replace = baseItem.posa_row_id;
                                const diffQty = baseItem.qty - offer.given_qty;
                                if (diffQty <= 0) {
                                        item.qty = baseItem.qty;
                                        const collection = this.items.includes(baseItem) ? this.items : this.packed_items;
                                        const idx = collection.findIndex((el) => el.posa_row_id == baseItem.posa_row_id);
					if (idx > -1) collection.splice(idx, 1);
					item.posa_row_id = item.posa_is_replace;
				} else {
					baseItem.qty = diffQty;
				}
				this.items.unshift(item);
				offer.give_item_row_id = item.posa_row_id;
                        } else {
                                // Reuse an already-given free item for this offer if one is sitting in
                                // the cart, rather than unconditionally creating another one. This
                                // matters when an invoice is saved and reloaded (e.g. "Apply Offers"):
                                // items are restored before posa_offers tracking is, so offer
                                // re-evaluation can briefly see this offer as "not yet applied" even
                                // though its free item is already present -- without this check that
                                // race adds a duplicate free item every time.
                                const combined = [...this.items, ...this.packed_items];
                                const existingGiven = combined.find(
                                        (el) => el && el.posa_is_offer && !el.posa_is_replace && el.item_code === offer.give_item,
                                );
                                if (existingGiven) {
                                        offer.give_item_row_id = existingGiven.posa_row_id;
                                        const desiredQty = flt(offer.given_qty);
                                        if (desiredQty > 0 && flt(existingGiven.qty) !== desiredQty) {
                                                existingGiven.qty = desiredQty;
                                                existingGiven.stock_qty = desiredQty;
                                                existingGiven.amount = this.flt(
                                                        existingGiven.qty * existingGiven.rate,
                                                        this.currency_precision,
                                                );
                                                existingGiven.base_amount = this.flt(
                                                        existingGiven.qty * existingGiven.base_rate,
                                                        this.currency_precision,
                                                );
                                        }
                                        // This reuse path never fetches item detail at all -- only
                                        // ApplyOnGiveProduct's fresh-creation path does. If this row's
                                        // price_list_rate never got a real value (e.g. it was created
                                        // once, the async detail fetch never landed a valid price for
                                        // some reason, and every later evaluation pass just keeps
                                        // reusing this same stuck row), nothing else will ever retry it.
                                        if (!existingGiven.price_list_rate) {
                                                this.update_item_detail(existingGiven, true);
                                        }
                                } else {
                                        const item = this.ApplyOnGiveProduct(offer);
                                        if (item) {
                                                this.items.unshift(item);
                                                offer.give_item_row_id = item.posa_row_id;
                                        } else {
                                                return;
                                        }
                                }
                        }
                }
		if (offer.offer === "Grand Total") {
			this.ApplyOnTotal(offer);
		}
		if (offer.offer === "Loyalty Point") {
			this.eventBus.emit("show_message", {
				title: __("Loyalty Point Offer Applied"),
				color: "success",
			});
		}

		const newOffer = {
			offer_name: offer.name,
			row_id: offer.row_id,
			apply_on: offer.apply_on,
			offer: offer.offer,
			items: JSON.stringify(offer.items),
			give_item: offer.give_item,
			give_item_row_id: offer.give_item_row_id,
			offer_applied: offer.offer_applied,
			coupon_based: offer.coupon_based,
			coupon: offer.coupon,
		};
		this.posa_offers.push(newOffer);
		this.addOfferToItems(newOffer);
	},

        notifyOfferItemUnavailable(itemCode = "") {
                const code = itemCode ? String(itemCode).trim() : "";
                const message = code
                        ? __("Unable to add offer item {0}. Please refresh and try again.", [code])
                        : __("Unable to add offer item. Please refresh and try again.");

                if (this && this.eventBus && typeof this.eventBus.emit === "function") {
                        this.eventBus.emit("show_message", {
                                title: __("Offer item unavailable"),
                                color: "error",
                                message,
                        });
                }

                console.warn("Offer item unavailable", { itemCode: code });
        },

        ApplyOnGiveProduct(offer, item_code) {
                if (!item_code) {
                        item_code = offer.give_item;
                }
                const items = Array.isArray(this.allItems) ? this.allItems : [];
                const item = items.find((item) => item && item.item_code == item_code);
                if (!item) {
                        this.notifyOfferItemUnavailable(item_code || (offer && offer.give_item));
                        return null;
                }
                const new_item = { ...item };
		new_item.qty = offer.given_qty;
		new_item.stock_qty = offer.given_qty;

		// Handle rate based on currency
		if (offer.discount_type === "Rate") {
			// offer.rate is always in base currency (PKR)
			new_item.base_rate = offer.rate;
			const baseCurrency = this.price_list_currency || this.pos_profile.currency;
			if (this.selected_currency !== baseCurrency) {
				// If exchange rate is 300 PKR = 1 USD
				// Convert PKR to USD by multiplying
				new_item.rate = this.flt(offer.rate * this.exchange_rate, this.currency_precision);
			} else {
				new_item.rate = offer.rate;
			}
		} else if (offer.discount_type === "Discount Percentage") {
			// Apply percentage discount on item's base rate
			const base_price = item.base_rate || item.rate / this.exchange_rate;
			const base_discount = this.flt(
				(base_price * offer.discount_percentage) / 100,
				this.currency_precision,
			);
			new_item.base_discount_amount = base_discount;
			new_item.base_rate = this.flt(base_price - base_discount, this.currency_precision);

			const baseCurrency = this.price_list_currency || this.pos_profile.currency;
			if (this.selected_currency !== baseCurrency) {
				new_item.discount_amount = this.flt(
					base_discount * this.exchange_rate,
					this.currency_precision,
				);
				new_item.rate = this.flt(new_item.base_rate * this.exchange_rate, this.currency_precision);
			} else {
				new_item.discount_amount = base_discount;
				new_item.rate = new_item.base_rate;
			}
		} else {
			// Use item's original rate
			const baseCurrency = this.price_list_currency || this.pos_profile.currency;
			if (this.selected_currency !== baseCurrency) {
				new_item.base_rate = item.base_rate || item.rate / this.exchange_rate;
				new_item.rate = item.rate;
			} else {
				new_item.base_rate = item.rate;
				new_item.rate = item.rate;
			}
		}

		// Handle discount amount based on currency
		if (offer.discount_type === "Discount Amount") {
			// offer.discount_amount is always in base currency (PKR)
			new_item.base_discount_amount = offer.discount_amount;
			const baseCurrency = this.price_list_currency || this.pos_profile.currency;
			if (this.selected_currency !== baseCurrency) {
				// Convert PKR to USD by multiplying
				new_item.discount_amount = this.flt(
					offer.discount_amount * this.exchange_rate,
					this.currency_precision,
				);
			} else {
				new_item.discount_amount = offer.discount_amount;
			}
		} else if (offer.discount_type !== "Discount Percentage") {
			new_item.base_discount_amount = 0;
			new_item.discount_amount = 0;
		}

		new_item.discount_percentage =
			offer.discount_type === "Discount Percentage" ? offer.discount_percentage : 0;
		new_item.discount_amount_per_item = 0;
		new_item.uom = item.uom ? item.uom : item.stock_uom;
		new_item.actual_batch_qty = "";
		new_item.conversion_factor = 1;
		new_item.posa_offers = JSON.stringify([]);
		new_item.posa_offer_applied =
			offer.discount_type === "Rate" ||
			offer.discount_type === "Discount Amount" ||
			offer.discount_type === "Discount Percentage"
				? 1
				: 0;
		new_item.posa_is_offer = 1;
		new_item.posa_is_replace = null;
		new_item.posa_notes = "";
		new_item.posa_delivery_date = "";

		// Handle free items
		const is_free =
			(offer.discount_type === "Rate" && !offer.rate) ||
			(offer.discount_type === "Discount Percentage" && offer.discount_percentage == 100);

		new_item.is_free_item = is_free ? 1 : 0;

		// A genuinely free row MUST carry discount_percentage=100, regardless of which
		// discount_type produced it (a "Rate"=0 free item would otherwise be left at 0 here).
		// ERPNext's own tax/total calculator (calculate_item_values() in
		// taxes_and_totals.py) -- which runs again on every save() regardless of
		// ignore_pricing_rule -- only ever treats discount_percentage === 100 as "this row is
		// free, leave rate at 0"; rate already being 0 is not itself protective. Without this,
		// a rate=0 row with discount_percentage=0 gets its rate silently recomputed from
		// price_list_rate the moment the invoice is saved.
		if (is_free) {
			new_item.discount_percentage = 100;
		}

		// Set price list rate based on currency similar to invoice logic. Always show the
		// item's real reference price here, even when it's being given away free -- rate/
		// base_rate (already 0 for the free case, set above) is what actually reflects the
		// free price; price_list_rate showing the true value lets the cashier/receipt see
		// what's being given away, instead of looking like the item is simply priced at 0.
		new_item.price_list_rate = item.price_list_rate ?? item.rate ?? 0;
		const baseCurrency = this.price_list_currency || this.pos_profile.currency;
		if (this.selected_currency !== baseCurrency) {
			new_item.base_price_list_rate = this.flt(
				item.base_price_list_rate !== undefined ? item.base_price_list_rate : item.rate / this.exchange_rate,
				this.currency_precision,
			);
		} else {
			new_item.base_price_list_rate =
				item.base_price_list_rate !== undefined ? item.base_price_list_rate : item.rate;
		}

		new_item.posa_row_id = this.makeid(20);

		if ((!this.pos_profile.posa_auto_set_batch && new_item.has_batch_no) || new_item.has_serial_no) {
			// Store only the item's row ID for the expanded state
			this.expanded.push(new_item.posa_row_id);
		}

		// Force-bypass the item detail cache (keyed by item_code+warehouse, 5s TTL): this is a
		// brand-new free-item row and must get authoritative live pricing, not risk reusing a
		// stale cached entry left over from an earlier, unrelated lookup of the same item_code
		// (e.g. from catalog browsing before customer/pricing context was fully set) -- which
		// left price_list_rate stuck at a wrong value until the cache happened to expire on its
		// own (matching "only updates after save or clicking the item").
		this.update_item_detail(new_item, true);
		return new_item;
	},

	ApplyOnPrice(offer) {
		if (!offer) return;

		const combined = [...this.items, ...this.packed_items];
		combined.forEach((item) => {
			// Check if offer.items exists and is valid
			if (!item || !offer.items || !Array.isArray(offer.items)) return;

			if (offer.items.includes(item.posa_row_id)) {
				// Ensure posa_offers is initialized and valid
				const item_offers = item.posa_offers ? JSON.parse(item.posa_offers) : [];
				if (!Array.isArray(item_offers)) return;

				if (!item_offers.includes(offer.row_id)) {
					// Store original rates only if this is the first offer being applied
					if (!item.posa_offer_applied) {
						// Store original prices normalized to conversion factor 1
						const cf = flt(item.conversion_factor || 1);
						item.original_base_rate = item.base_rate / cf;
						item.original_base_price_list_rate = item.base_price_list_rate / cf;
						item.original_rate = item.rate / cf;
						item.original_price_list_rate = item.price_list_rate / cf;
					}

					const conversion_factor = flt(item.conversion_factor || 1);

					if (offer.discount_type === "Rate") {
						// offer.rate is always in base currency (e.g. PKR)
						const base_offer_rate = flt(offer.rate * conversion_factor);

						// Determine original base price for reference
						const base_price = this.flt(
							(item.original_base_price_list_rate ??
								item.base_price_list_rate / conversion_factor) * conversion_factor,
							this.currency_precision,
						);

						// Set base rates and keep original price list rate
						item.base_rate = base_offer_rate;
						item.base_price_list_rate = base_price;

						// Convert to selected currency if needed
						const baseCurrency = this.price_list_currency || this.pos_profile.currency;
						if (this.selected_currency !== baseCurrency) {
							// If exchange rate is 285 PKR = 1 USD
							// To convert PKR to USD multiply by exchange rate
							item.rate = this.flt(
								base_offer_rate * this.exchange_rate,
								this.currency_precision,
							);
							item.price_list_rate = this.flt(
								base_price * this.exchange_rate,
								this.currency_precision,
							);
							item.discount_amount = this.flt(
								(base_price - base_offer_rate) * this.exchange_rate,
								this.currency_precision,
							);
						} else {
							item.rate = base_offer_rate;
							item.price_list_rate = base_price;
							item.discount_amount = this.flt(
								base_price - base_offer_rate,
								this.currency_precision,
							);
						}

						// Compute base discount amounts and percentage
						item.base_discount_amount = this.flt(
							base_price - base_offer_rate,
							this.currency_precision,
						);
						item.discount_percentage = base_price
							? this.flt(
									(item.base_discount_amount / base_price) * 100,
									this.currency_precision,
								)
							: 0;
					} else if (offer.discount_type === "Discount Percentage") {
						item.discount_percentage = offer.discount_percentage;

						// Calculate discount in base currency first
						// Use normalized price * current conversion factor
						const base_price = this.flt(
							(item.original_base_price_list_rate ??
								item.base_price_list_rate / conversion_factor) * conversion_factor,
							this.currency_precision,
						);
						const base_discount = this.flt(
							(base_price * offer.discount_percentage) / 100,
							this.currency_precision,
						);
						item.base_discount_amount = base_discount;
						item.base_rate = this.flt(base_price - base_discount, this.currency_precision);

						// Keep price list rate at original price
						item.base_price_list_rate = base_price;

						// Convert to selected currency if needed
						const baseCurrency = this.price_list_currency || this.pos_profile.currency;
						if (this.selected_currency !== baseCurrency) {
							item.rate = this.flt(
								item.base_rate * this.exchange_rate,
								this.currency_precision,
							);
							item.price_list_rate = this.flt(
								base_price * this.exchange_rate,
								this.currency_precision,
							);
							item.discount_amount = this.flt(
								base_discount * this.exchange_rate,
								this.currency_precision,
							);
						} else {
							item.rate = item.base_rate;
							item.price_list_rate = base_price;
							item.discount_amount = base_discount;
						}
					}

					// Calculate final amounts
					item.amount = this.flt(item.qty * item.rate, this.currency_precision);
					item.base_amount = this.flt(item.qty * item.base_rate, this.currency_precision);

					item.posa_offer_applied = 1;
					this.$forceUpdate();
				}
			}
		});
	},

	RemoveOnPrice(offer) {
		if (!offer) return;

		const combined = [...this.items, ...this.packed_items];
		combined.forEach((item) => {
			if (!item || !item.posa_offers) return;

			try {
				const item_offers = JSON.parse(item.posa_offers);
				if (!Array.isArray(item_offers)) return;

				if (item_offers.includes(offer.row_id)) {
					// Check if we have original rates stored
					if (!item.original_base_rate) {
						console.warn("Original rates not found, fetching from server");
						this.update_item_detail(item);
						return;
					}

					// Get current conversion factor
					const cf = flt(item.conversion_factor || 1);

					// Restore original rates adjusted for current conversion factor
					item.base_rate = this.flt(item.original_base_rate * cf, this.currency_precision);
					item.base_price_list_rate = this.flt(
						item.original_base_price_list_rate * cf,
						this.currency_precision,
					);

					// Convert to selected currency
					const baseCurrency = this.price_list_currency || this.pos_profile.currency;
					if (this.selected_currency !== baseCurrency) {
						item.rate = this.flt(item.base_rate * this.exchange_rate, this.currency_precision);
						item.price_list_rate = this.flt(
							item.base_price_list_rate * this.exchange_rate,
							this.currency_precision,
						);
					} else {
						item.rate = item.base_rate;
						item.price_list_rate = item.base_price_list_rate;
					}

					// Reset all discounts
					item.discount_percentage = 0;
					item.discount_amount = 0;
					item.base_discount_amount = 0;

					// Recalculate amounts
					item.amount = this.flt(item.qty * item.rate, this.currency_precision);
					item.base_amount = this.flt(item.qty * item.base_rate, this.currency_precision);

					// Only clear original rates if no other offers are applied
					const remaining_offers = item_offers.filter((id) => id !== offer.row_id);
					if (remaining_offers.length === 0) {
						item.original_base_rate = null;
						item.original_base_price_list_rate = null;
						item.original_rate = null;
						item.original_price_list_rate = null;
						item.posa_offer_applied = 0;
					}

					// Update posa_offers
					item.posa_offers = JSON.stringify(remaining_offers);

					// Force UI update
					this.$forceUpdate();
				}
			} catch (error) {
				console.error("Error removing price offer:", error);
				this.eventBus.emit("show_message", {
					title: __("Error removing price offer"),
					color: "error",
					message: error.message,
				});
			}
		});
	},

	ApplyOnCombo(offer) {
		if (!offer || !Array.isArray(offer.combo_breakdown) || !offer.combo_total_amount) return;

		const totalAmount = flt(offer.combo_total_amount);
		const instances = flt(offer.combo_instances) || 1;
		const totalDiscount = Math.min(flt(offer.discount_amount) * instances, totalAmount);
		if (!totalDiscount) return;

		const MAX_PRICE_WAIT_RETRIES = 6;
		this._comboPriceRetryCounts = this._comboPriceRetryCounts || {};

		const combined = [...this.items, ...this.packed_items];
		const pendingRetryRowIds = [];

		offer.combo_breakdown.forEach((entry) => {
			if (!entry.amount || !Array.isArray(entry.rows) || !entry.rows.length) return;

			// Cross-item split uses usedAmount (this item's contribution to the qualifying
			// sets only), not its full cart amount -- see getComboOffer. Row-level splitting
			// below still uses the full amounts, since that's just dividing THIS item's own
			// share fairly across its own rows/leftover quantity, not affecting other items.
			const entryDiscount = this.flt(
				(totalDiscount * entry.usedAmount) / totalAmount,
				this.currency_precision,
			);

			entry.rows.forEach((row) => {
				if (!row.amount) return;

				const item = combined.find((el) => el && el.posa_row_id === row.row_id);
				if (!item || !item.qty) return;

				const rowShare = this.flt((entryDiscount * row.amount) / entry.amount, this.currency_precision);
				if (!rowShare) return;

				const conversion_factor = flt(item.conversion_factor || 1);

				// Has THIS combo offer already snapshotted this row's pre-discount rates?
				// Used below only to decide whether to (re-)write the original_* restore
				// snapshot -- NOT to derive this pass's base_price (see next comment).
				let rowOfferIds = [];
				try {
					const parsed = item.posa_offers ? JSON.parse(item.posa_offers) : [];
					if (Array.isArray(parsed)) rowOfferIds = parsed;
				} catch (error) {
					rowOfferIds = [];
				}
				const alreadySnapshotted =
					rowOfferIds.includes(offer.row_id) && flt(item.base_discount_amount) > 0;

				// Base price (pre-discount) for this row: item.base_price_list_rate is safe to
				// read directly on every pass, including repeat ones -- this function always
				// writes it back as the FULL reference price a few lines down
				// (`item.base_price_list_rate = base_price;`), never the discounted value, so
				// there's no compounding risk. A dedicated original_base_price_list_rate
				// snapshot used to gate this instead, but that field isn't persisted: after a
				// save + reload it's always undefined even though alreadySnapshotted is
				// (correctly) true, since base_discount_amount/posa_offers ARE persisted --
				// forcing every row through the retry-then-fallback path below on EVERY pass
				// for the rest of the session (alreadySnapshotted never goes false again to
				// let a real snapshot happen), which reads to the user as the rate being
				// permanently frozen rather than just delayed.
				let base_price = this.flt(
					(item.base_price_list_rate / conversion_factor) * conversion_factor,
					this.currency_precision,
				);

				// The item's price may not have finished loading yet (item detail is
				// fetched asynchronously right after it's added to the cart). Discounting
				// against a zero/invalid price would produce a negative rate, so give it a
				// few short retries once its real price is available...
				if (!(base_price > 0)) {
					const attempts = (this._comboPriceRetryCounts[row.row_id] || 0) + 1;
					this._comboPriceRetryCounts[row.row_id] = attempts;

					if (attempts <= MAX_PRICE_WAIT_RETRIES) {
						pendingRetryRowIds.push(row.row_id);
						return;
					}

					// ...but never retry forever: after a few attempts, fall back to the
					// item's display price (price_list_rate is populated synchronously when
					// the item is added, unlike base_price_list_rate) so the combo still
					// applies instead of retrying indefinitely.
					console.warn(
						"Combo offer: base_price_list_rate never became available, falling back to price_list_rate",
						{ item_code: item.item_code, row_id: row.row_id },
					);
					base_price = this.flt(item.original_price_list_rate ?? item.price_list_rate ?? 0, this.currency_precision);
					if (!(base_price > 0)) return;
				}

				delete this._comboPriceRetryCounts[row.row_id];

				// Only now that base_price is confirmed valid do we snapshot it -- writing
				// it earlier (before the retry/fallback check above) would risk permanently
				// freezing the snapshot at an invalid 0 the first time this row is touched,
				// forcing every future pass back through the retry/fallback path forever.
				if (!alreadySnapshotted) {
					item.original_base_rate = item.base_rate / conversion_factor;
					item.original_base_price_list_rate = this.flt(base_price / conversion_factor, this.currency_precision);
					item.original_rate = item.rate / conversion_factor;
					item.original_price_list_rate = item.price_list_rate / conversion_factor;
				}

				const perUnitDiscount = this.flt(rowShare / item.qty, this.currency_precision);

				item.base_discount_amount = perUnitDiscount;
				item.base_rate = this.flt(base_price - perUnitDiscount, this.currency_precision);
				item.base_price_list_rate = base_price;

				const baseCurrency = this.price_list_currency || this.pos_profile.currency;
				if (this.selected_currency !== baseCurrency) {
					item.rate = this.flt(item.base_rate * this.exchange_rate, this.currency_precision);
					item.price_list_rate = this.flt(base_price * this.exchange_rate, this.currency_precision);
					item.discount_amount = this.flt(perUnitDiscount * this.exchange_rate, this.currency_precision);
				} else {
					item.rate = item.base_rate;
					item.price_list_rate = base_price;
					item.discount_amount = perUnitDiscount;
				}

				item.discount_percentage = base_price
					? this.flt((perUnitDiscount / base_price) * 100, this.currency_precision)
					: 0;

				item.amount = this.flt(item.qty * item.rate, this.currency_precision);
				item.base_amount = this.flt(item.qty * item.base_rate, this.currency_precision);

				item.posa_offer_applied = 1;
			});
		});

		if (pendingRetryRowIds.length) {
			// Exclude skipped rows from offer.items so addOfferToItems() (called by the
			// caller right after this) doesn't mark them posa_offer_applied before they've
			// actually been discounted -- that would block the retry from ever picking them up.
			if (Array.isArray(offer.items)) {
				offer.items = offer.items.filter((rowId) => !pendingRetryRowIds.includes(rowId));
			}

			setTimeout(() => {
				if (typeof this.scheduleOfferRefresh === "function") {
					this.scheduleOfferRefresh(pendingRetryRowIds);
				}
			}, 300);
		}

		this.$forceUpdate();
	},

	ApplyOnTotal(offer) {
		if (!offer.name) {
			offer = this.posOffers.find((el) => el.name == offer.offer_name);
		}
		if (this.discount_percentage_offer_name === offer.name && this.discount_amount !== 0) {
			// Discount already applied, do not recalculate when items change
			return;
		}
		if (
			(!this.discount_percentage_offer_name || this.discount_percentage_offer_name == offer.name) &&
			offer.discount_percentage > 0 &&
			offer.discount_percentage <= 100
		) {
			this.discount_amount = this.flt(
				(flt(this.Total) * flt(offer.discount_percentage)) / 100,
				this.currency_precision,
			);
			this.discount_percentage_offer_name = offer.name;

			// Update invoice level discount fields so the value
			// is reflected in the UI and saved correctly
			this.additional_discount = this.discount_amount;
			if (this.Total && this.Total !== 0) {
				this.additional_discount_percentage = (this.discount_amount / this.Total) * 100;
			} else {
				this.additional_discount_percentage = 0;
			}
		}
	},

	RemoveOnTotal(offer) {
		if (this.discount_percentage_offer_name && this.discount_percentage_offer_name == offer.offer_name) {
			this.discount_amount = 0;
			this.discount_percentage_offer_name = null;

			// Reset invoice discount fields when offer is removed
			this.additional_discount = 0;
			this.additional_discount_percentage = 0;
		}
	},

	addOfferToItems(offer) {
		if (!offer || !offer.items) return;

		try {
			const offer_items = typeof offer.items === "string" ? JSON.parse(offer.items) : offer.items;
			if (!Array.isArray(offer_items)) return;

			const combined = [...this.items, ...this.packed_items];
			offer_items.forEach((el) => {
				combined.forEach((exist_item) => {
					if (!exist_item || !exist_item.posa_row_id) return;

					if (exist_item.posa_row_id == el) {
						const item_offers = exist_item.posa_offers ? JSON.parse(exist_item.posa_offers) : [];
						if (!Array.isArray(item_offers)) return;

						if (!item_offers.includes(offer.row_id)) {
							item_offers.push(offer.row_id);
							if (offer.offer === "Item Price") {
								exist_item.posa_offer_applied = 1;
							}
						}
						exist_item.posa_offers = JSON.stringify(item_offers);
					}
				});
			});
		} catch (error) {
			console.error("Error adding offer to items:", error);
			this.eventBus.emit("show_message", {
				title: __("Error adding offer to items"),
				color: "error",
				message: error.message,
			});
		}
	},

	deleteOfferFromItems(offer) {
		if (!offer || !offer.items) return;

		try {
			const offer_items = typeof offer.items === "string" ? JSON.parse(offer.items) : offer.items;
			if (!Array.isArray(offer_items)) return;

			const combined = [...this.items, ...this.packed_items];
			offer_items.forEach((el) => {
				combined.forEach((exist_item) => {
					if (!exist_item || !exist_item.posa_row_id) return;

					if (exist_item.posa_row_id == el) {
						const item_offers = exist_item.posa_offers ? JSON.parse(exist_item.posa_offers) : [];
						if (!Array.isArray(item_offers)) return;

						const updated_item_offers = item_offers.filter((row_id) => row_id != offer.row_id);
						if (offer.offer === "Item Price") {
							exist_item.posa_offer_applied = 0;
						}
						exist_item.posa_offers = JSON.stringify(updated_item_offers);
					}
				});
			});
		} catch (error) {
			console.error("Error deleting offer from items:", error);
			this.eventBus.emit("show_message", {
				title: __("Error deleting offer from items"),
				color: "error",
				message: error.message,
			});
		}
	},

	validate_due_date(item) {
		const today = frappe.datetime.now_date();
		const parse_today = Date.parse(today);
		// Convert to backend format for comparison
		const backend_date = this.formatDateForBackend(item.posa_delivery_date);
		const new_date = Date.parse(backend_date);
		if (isNaN(new_date) || new_date < parse_today) {
			setTimeout(() => {
				item.posa_delivery_date = this.formatDateForDisplay(today);
			}, 0);
		} else {
			item.posa_delivery_date = this.formatDateForDisplay(backend_date);
		}
	},
	load_print_page(invoice_name) {
		const print_format = this.pos_profile.print_format_for_online || this.pos_profile.print_format;
		const letter_head = this.pos_profile.letter_head || 0;
		const doctype = this.pos_profile.create_pos_invoice_instead_of_sales_invoice
			? "POS Invoice"
			: "Sales Invoice";
		const url =
			frappe.urllib.get_base_url() +
			"/printview?doctype=" +
			encodeURIComponent(doctype) +
			"&name=" +
			invoice_name +
			"&trigger_print=1" +
			"&format=" +
			print_format +
			"&no_letterhead=" +
			letter_head;

                if (this.pos_profile.posa_silent_print) {
                        silentPrint(url, { allowOfflineFallback: isOffline() });
                } else {
			const printWindow = window.open(url, "Print");
			printWindow.addEventListener(
				"load",
				function () {
					printWindow.print();
				},
				{ once: true },
			);
		}
	},

	formatDateForBackend(date) {
		if (!date) return null;
		if (typeof date === "string") {
			const western = formatUtils.fromArabicNumerals(date);
			if (/^\d{4}-\d{2}-\d{2}$/.test(western)) {
				return western;
			}
			if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(western)) {
				const [d, m, y] = western.split("-");
				return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
			}
			date = western;
		}
		const d = new Date(formatUtils.fromArabicNumerals(String(date)));
		if (!isNaN(d.getTime())) {
			const year = d.getFullYear();
			const month = `0${d.getMonth() + 1}`.slice(-2);
			const day = `0${d.getDate()}`.slice(-2);
			return `${year}-${month}-${day}`;
		}
		return formatUtils.fromArabicNumerals(String(date));
	},

	formatDateForDisplay(date) {
		if (!date) return "";
		const western = formatUtils.fromArabicNumerals(String(date));
		if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(western)) {
			const [y, m, d] = western.split("-");
			return formatUtils.toArabicNumerals(`${d}-${m}-${y}`);
		}
		const d = new Date(western);
		if (!isNaN(d.getTime())) {
			const year = d.getFullYear();
			const month = `0${d.getMonth() + 1}`.slice(-2);
			const day = `0${d.getDate()}`.slice(-2);
			return formatUtils.toArabicNumerals(`${day}-${month}-${year}`);
		}
		return formatUtils.toArabicNumerals(western);
	},

	toggleOffer(item) {
		this.$nextTick(() => {
			if (item.posa_offer_applied) {
				// Remove applied offer and restore original pricing
				item.posa_is_offer = 1;
				item.posa_offers = JSON.stringify([]);
				item.posa_offer_applied = 0;
				item.discount_percentage = 0;
				item.discount_amount = 0;
				item.base_discount_amount = 0;

				// Restore previous rates if stored, adjusted for current UOM
				const cf = flt(item.conversion_factor || 1);
				item.rate = item.original_rate ? item.original_rate * cf : item.price_list_rate;
				item.price_list_rate = item.original_price_list_rate
					? item.original_price_list_rate * cf
					: item.price_list_rate;
				item.base_rate = item.original_base_rate ? item.original_base_rate * cf : item.base_rate;
				item.base_price_list_rate = item.original_base_price_list_rate
					? item.original_base_price_list_rate * cf
					: item.base_price_list_rate;

				// Clear stored original rates
				item.original_rate = null;
				item.original_price_list_rate = null;
				item.original_base_rate = null;
				item.original_base_price_list_rate = null;

				this.calc_item_price(item);
				this.handelOffers();
			} else {
				// Allow offers to be applied
				item.posa_is_offer = 0;
				this.handelOffers();
			}

			// Ensure Vue reactivity
			this.$forceUpdate();
		});
	},
};
