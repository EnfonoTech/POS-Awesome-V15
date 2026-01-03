/* global __, frappe, flt */
import {
	isOffline,
	saveCustomerBalance,
	getCachedCustomerBalance,
	getCachedPriceListItems,
	getCustomerStorage,
	getOfflineCustomers,
	getTaxTemplate,
	getTaxInclusiveSetting,
	getOpeningStorage,
} from "../../../offline/index.js";

// Import composables
import { useBatchSerial } from "../../composables/useBatchSerial.js";
import { useDiscounts } from "../../composables/useDiscounts.js";
import { useItemAddition } from "../../composables/useItemAddition.js";
import { useStockUtils } from "../../composables/useStockUtils.js";
import stockCoordinator from "../../utils/stockCoordinator.js";

const ITEM_DETAIL_CACHE_TTL = 5000;
const STOCK_CACHE_TTL = 5000;

const { setSerialNo, setBatchQty } = useBatchSerial();
const { updateDiscountAmount, calcPrices, calcItemPrice } = useDiscounts();
const { removeItem, addItem, getNewItem, clearInvoice } = useItemAddition();
const { calcUom, calcStockQty } = useStockUtils();

export default {
	_ensureTaskBucket(rowId) {
		if (!rowId) {
			return null;
		}
		if (!this._itemTaskCache) {
			this._itemTaskCache = new Map();
		}
		if (!this._itemTaskCache.has(rowId)) {
			this._itemTaskCache.set(rowId, {});
		}
		return this._itemTaskCache.get(rowId);
	},
	_getItemTaskPromise(rowId, taskName) {
		if (!rowId || !this._itemTaskCache) {
			return null;
		}
		const bucket = this._itemTaskCache.get(rowId);
		return bucket ? bucket[taskName] || null : null;
	},
	_setItemTaskPromise(rowId, taskName, promise) {
		if (!rowId || !promise) {
			return promise;
		}
		const bucket = this._ensureTaskBucket(rowId);
		const trackedPromise = Promise.resolve(promise).finally(() => {
			const activeBucket = this._itemTaskCache ? this._itemTaskCache.get(rowId) : null;
			if (activeBucket) {
				delete activeBucket[taskName];
				if (!Object.keys(activeBucket).length) {
					this._itemTaskCache.delete(rowId);
				}
			}
		});
		bucket[taskName] = trackedPromise;
		return trackedPromise;
	},
	resetItemTaskCache(rowId, taskName = null) {
		if (!this._itemTaskCache) {
			return;
		}
		if (!rowId) {
			this._itemTaskCache = new Map();
			return;
		}
		if (taskName === null) {
			this._itemTaskCache.delete(rowId);
			return;
		}
		const bucket = this._itemTaskCache.get(rowId);
		if (!bucket) {
			return;
		}
		delete bucket[taskName];
		if (!Object.keys(bucket).length) {
			this._itemTaskCache.delete(rowId);
		}
	},
	queueItemTask(itemOrRowId, taskName, taskFn, options = {}) {
		const rowId = typeof itemOrRowId === "string" ? itemOrRowId : itemOrRowId?.posa_row_id;
		const { force = false } = options;
		const executeTask = () => Promise.resolve().then(() => taskFn());

		if (!rowId) {
			return executeTask();
		}

		if (force) {
			this.resetItemTaskCache(rowId, taskName);
		} else {
			const existing = this._getItemTaskPromise(rowId, taskName);
			if (existing) {
				return existing;
			}
		}

		const promise = executeTask();
		return this._setItemTaskPromise(rowId, taskName, promise);
	},
	hasItemTaskPromise(rowId, taskName) {
		return !!this._getItemTaskPromise(rowId, taskName);
	},
	getItemTaskPromise(rowId, taskName) {
		return this._getItemTaskPromise(rowId, taskName);
	},
	_getItemDetailCacheKey(item) {
		const code = item?.item_code;
		const warehouse = item?.warehouse || this.pos_profile?.warehouse;
		if (!code || !warehouse) {
			return null;
		}
		return `${code}::${warehouse}`;
	},
	_getCachedItemDetail(key) {
		if (!key) {
			return null;
		}
		const cache = this.item_detail_cache || {};
		const entry = cache[key];
		if (!entry) {
			return null;
		}
		if (Date.now() - entry.ts > ITEM_DETAIL_CACHE_TTL) {
			delete cache[key];
			return null;
		}
		return entry.data;
	},
	_storeItemDetailCache(key, data) {
		if (!key || !data) {
			return;
		}
		if (!this.item_detail_cache) {
			this.item_detail_cache = {};
		}
		this.item_detail_cache[key] = {
			ts: Date.now(),
			data: JSON.parse(JSON.stringify(data)),
		};
	},
	clearItemDetailCache() {
		this.item_detail_cache = {};
	},
	_getStockCacheKey(item) {
		const code = item?.item_code;
		const warehouse = item?.warehouse || this.pos_profile?.warehouse;
		if (!code || !warehouse) {
			return null;
		}
		return `${code}::${warehouse}`;
	},
	_getCachedStockQty(key) {
		if (!key) {
			return null;
		}
		const cache = this.item_stock_cache || {};
		const entry = cache[key];
		if (!entry) {
			return null;
		}
		if (Date.now() - entry.ts > STOCK_CACHE_TTL) {
			delete cache[key];
			return null;
		}
		return entry.qty;
	},
	_storeStockQty(key, qty) {
		if (!key) {
			return;
		}
		if (!this.item_stock_cache) {
			this.item_stock_cache = {};
		}
		this.item_stock_cache[key] = { ts: Date.now(), qty };
	},
	clearItemStockCache() {
		this.item_stock_cache = {};
	},
	remove_item(item) {
		return removeItem(item, this);
	},

	async add_item(item, options = {}) {
		const res = await addItem(item, this);

		const shouldNotify =
			options?.notifyOnSuccess === true && !options?.skipNotification && this.eventBus?.emit;

		if (shouldNotify) {
			const rawQty = typeof item?.qty === "number" ? item.qty : parseFloat(item?.qty);
			const shouldAnnounce = Number.isFinite(rawQty) ? rawQty > 0 : true;

			if (shouldAnnounce) {
				const addedQty = Number.isFinite(rawQty) ? Math.abs(rawQty) : 1;
				const rawPrecision = Number(this.float_precision);
				const precision = Number.isInteger(rawPrecision) ? Math.min(Math.max(rawPrecision, 0), 6) : 2;
				const displayQty = Number.isInteger(addedQty)
					? addedQty
					: Number(addedQty.toFixed(precision));
				const itemName = item?.item_name || item?.item_code || __("Item");
				const detail = __("{0} (Qty: {1})", [itemName, displayQty]);

				this.eventBus.emit("show_message", {
					title: __("Item {0} added to invoice", [itemName]),
					summary: __("Items added to invoice"),
					detail,
					color: "success",
					groupId: "invoice-item-added",
				});
			}
		}

		return res;
	},

	// Create a new item object with default and calculated fields
	get_new_item(item) {
		return getNewItem(item, this);
	},

	// Reset all invoice fields to default/empty values
	clear_invoice() {
		return clearInvoice(this);
	},

	// Fetch customer balance from backend or cache
	async fetch_customer_balance() {
		try {
			if (!this.customer) {
				this.customer_balance = 0;
				return;
			}

			// Check if offline and use cached balance
			if (isOffline()) {
				const cachedBalance = getCachedCustomerBalance(this.customer);
				if (cachedBalance !== null) {
					this.customer_balance = cachedBalance;
					return;
				} else {
					// No cached balance available in offline mode
					this.customer_balance = 0;
					this.eventBus.emit("show_message", {
						title: __("Customer balance unavailable offline"),
						text: __("Balance will be updated when connection is restored"),
						color: "warning",
					});
					return;
				}
			}

			// Online mode: fetch from server and cache the result
			const r = await frappe.call({
				method: "posawesome.posawesome.api.customer.get_customer_balance",
				args: { customer: this.customer },
			});

			const balance = r?.message?.balance || 0;
			this.customer_balance = balance;

			// Cache the balance for offline use
			saveCustomerBalance(this.customer, balance);
		} catch (error) {
			console.error("Error fetching balance:", error);

			// Try to use cached balance as fallback
			const cachedBalance = getCachedCustomerBalance(this.customer);
			if (cachedBalance !== null) {
				this.customer_balance = cachedBalance;
				this.eventBus.emit("show_message", {
					title: __("Using cached customer balance"),
					text: __("Could not fetch latest balance from server"),
					color: "warning",
				});
			} else {
				this.eventBus.emit("show_message", {
					title: __("Error fetching customer balance"),
					color: "error",
				});
				this.customer_balance = 0;
			}
		}
	},

	// Cancel the current invoice, optionally delete from backend
	async cancel_invoice() {
		// Only get invoice doc if invoice_doc exists to avoid null reference errors
		let doc = null;
		if (this.invoice_doc) {
			doc = this.get_invoice_doc();
		}
		this.invoiceType = this.pos_profile.posa_default_sales_order ? "Order" : "Invoice";
		this.invoiceTypes = ["Invoice", "Order", "Quotation"];
		this.posting_date = frappe.datetime.nowdate();
		var vm = this;
		if (doc && doc.name && this.pos_profile.posa_allow_delete) {
			await frappe.call({
				method: "posawesome.posawesome.api.invoices.delete_invoice",
				args: { invoice: doc.name },
				async: true,
				callback: function (r) {
					if (r.message) {
						vm.eventBus.emit("show_message", {
							text: r.message,
							color: "warning",
						});
					}
				},
			});
		}
		this.clear_invoice();
		this.eventBus.emit("focus_item_search");
		this.cancel_dialog = false;
	},

	// Load an invoice (or return invoice) from data, set all fields accordingly
	async load_invoice(data = {}) {
		console.log("load_invoice called with data:", {
			is_return: data.is_return,
			return_against: data.return_against,
			customer: data.customer,
			items_count: data.items ? data.items.length : 0,
		});

		this.clear_invoice();
		if (data.is_return) {
			console.log("Processing return invoice");
			this.invoiceType = "Return";
			this.invoiceTypes = ["Return"];
		}

		this.invoice_doc = data;
		// Preserve sales_order if it exists in items but not in invoice_doc
		if (!this.invoice_doc.sales_order && this.items && this.items.length > 0) {
			const firstItemWithSO = this.items.find(item => item.sales_order);
			if (firstItemWithSO && firstItemWithSO.sales_order) {
				this.invoice_doc.sales_order = firstItemWithSO.sales_order;
			}
		}
		
		// Ensure advances array is reactive if it exists
		if (this.invoice_doc.advances && Array.isArray(this.invoice_doc.advances)) {
			// Make sure it's reactive
			if (this.$set) {
				this.$set(this.invoice_doc, 'advances', [...this.invoice_doc.advances]);
			}
		}
		this.items = data.items || [];
		this.packed_items = data.packed_items || [];
		console.log("Items set:", this.items.length, "items");

		if (data.is_return && data.return_against) {
			this.items.forEach((item) => {
				item.locked_price = true;
			});
			this.packed_items.forEach((pi) => {
				pi.locked_price = true;
			});
		}

		if (this.items.length > 0) {
			this.items.forEach((item) => {
				if (!item.posa_row_id) {
					item.posa_row_id = this.makeid(20);
				}
				// Only set batch_qty if batch_no_data is available (to avoid errors during invoice reload)
				if (item.batch_no && item.batch_no_data && Array.isArray(item.batch_no_data) && item.batch_no_data.length > 0) {
					this.set_batch_qty(item, item.batch_no);
				} else if (item.batch_no) {
					// Just preserve the batch_no value without processing batch data
					// The batch data will be loaded later via update_items_details
					item.batch_no = item.batch_no;
				}
				if (!item.original_item_name) {
					item.original_item_name = item.item_name;
				}
			});

			const manualSnapshots = this._snapshotManualValuesFromDocItems(this.items);

			await this.update_items_details(this.items);

			if (manualSnapshots.length) {
				this._restoreManualSnapshots(this.items, manualSnapshots);
			}

			this.posa_offers = data.posa_offers || [];
		} else {
			console.log("Warning: No items in return invoice");
		}

	if (this.packed_items.length > 0) {
		this.update_items_details(this.packed_items);
		this.packed_items.forEach((pi) => {
			if (!pi.posa_row_id) {
				pi.posa_row_id = this.makeid(20);
			}
		});
	}

	// When loading an invoice from backend (has name), always use the invoice's customer
	// When creating a new invoice (no name), preserve the selected customer from store
	// Exception: Return invoices ALWAYS use data.customer (from original invoice)
	if (data.is_return && data.customer) {
		// Return invoice - ALWAYS use the customer from the original invoice
		this.customer = data.customer;
		if (this.customersStore) {
			this.customersStore.setSelectedCustomer(data.customer);
		}
	} else if (data.name) {
		// Existing invoice from backend - ALWAYS use invoice's customer (no fallback)
		// A saved invoice must have a customer, so trust data.customer completely
		this.customer = data.customer;
		// Set persistent flag to preserve this customer through clearInvoice calls
		this._savedInvoiceCustomer = data.customer;
		if (this.customersStore && data.customer) {
			this.customersStore.setSelectedCustomer(data.customer);
		}
	} else {
		// New invoice - preserve selected customer from store if available
		const currentCustomer = this.customersStore?.selectedCustomer || this.customer;
		if (data.customer && !currentCustomer) {
			this.customer = data.customer;
			if (this.customersStore) {
				this.customersStore.setSelectedCustomer(data.customer);
			}
		} else if (currentCustomer) {
			// Preserve the current customer from store
			this.customer = currentCustomer;
		} else {
			this.customer = data.customer;
		}
	}
	this.posting_date = this.formatDateForBackend(data.posting_date || frappe.datetime.nowdate());
		this.discount_amount = data.discount_amount;
		this.additional_discount_percentage = data.additional_discount_percentage;
		this.additional_discount = data.discount_amount;
		
		// If invoice has sales_order but no advances, fetch them
		// This handles the case when invoice is reloaded from backend
		// Check multiple sources for sales_order: invoice_doc, items, or stored sales_order_name
		let sales_order_to_check = this.invoice_doc.sales_order;
		if (!sales_order_to_check && this.items && this.items.length > 0) {
			const firstItemWithSO = this.items.find(item => item.sales_order);
			if (firstItemWithSO && firstItemWithSO.sales_order) {
				sales_order_to_check = firstItemWithSO.sales_order;
			}
		}
		if (!sales_order_to_check && this.sales_order_name) {
			sales_order_to_check = this.sales_order_name;
		}
		
		if (sales_order_to_check && (!this.invoice_doc.advances || this.invoice_doc.advances.length === 0)) {
			// Store sales_order_name for later use
			this.sales_order_name = sales_order_to_check;
			// Ensure sales_order is set on invoice_doc
			if (!this.invoice_doc.sales_order) {
				if (this.$set) {
					this.$set(this.invoice_doc, 'sales_order', sales_order_to_check);
				} else {
					this.invoice_doc.sales_order = sales_order_to_check;
				}
			}
			this.$nextTick(() => {
				setTimeout(() => {
					this.fetch_and_set_advances(sales_order_to_check);
				}, 500);
			});
		}

		if (this.items.length > 0) {
			this.items.forEach((item) => {
				if (item.serial_no) {
					item.serial_no_selected = [];
					const serial_list = item.serial_no.split("\n");
					serial_list.forEach((element) => {
						if (element.length) {
							item.serial_no_selected.push(element);
						}
					});
					item.serial_no_selected_count = item.serial_no_selected.length;
				}
			});
		}

		if (data.is_return) {
			this.return_doc = data;
		} else {
			this.eventBus.emit("set_pos_coupons", data.posa_coupons);
		}

	},

	// Save and clear the current invoice (draft logic)
	async save_and_clear_invoice() {
		let old_invoice = null;
		// Only get invoice doc if invoice_doc exists to avoid null reference errors
		if (!this.invoice_doc && !this.items.length) {
			this.clear_invoice();
			this.eventBus.emit("focus_item_search");
			return null;
		}
		const doc = this.get_invoice_doc();

		try {
			if (doc.name) {
				old_invoice = await this.update_invoice(doc);
			} else if (doc.items.length) {
				old_invoice = await this.update_invoice(doc);
			} else {
				this.eventBus.emit("show_message", {
					title: `Nothing to save`,
					color: "error",
				});
			}
		} catch (error) {
			console.error("Error saving and clearing invoice:", error);
		}

		if (!old_invoice) {
			this.eventBus.emit("show_message", {
				title: `Error saving the current invoice`,
				color: "error",
			});
		} else {
			this.clear_invoice();
			this.eventBus.emit("focus_item_search");
			return old_invoice;
		}
	},

	// Load sales order data into invoice
	async load_sales_order_to_invoice(data = {}) {
		// Clear current invoice first
		this.clear_invoice();
		
		// Set customer and mark it as from sales order (should be preserved)
		if (data.customer) {
			this.customer = data.customer;
			// Flag to preserve this customer (from sales order)
			this._customerFromSalesOrder = data.customer;
			if (this.customersStore && data.customer) {
				this.customersStore.setSelectedCustomer(data.customer);
			}
		}
		
		// Set invoice type
		this.invoiceType = "Invoice";
		this.invoiceTypes = ["Invoice", "Order", "Quotation"];
		
		// Store sales order reference and advance paid
		this.sales_order_name = data.sales_order || null;
		this.sales_order_advance_paid = flt(data.advance_paid || 0);
		
		// Initialize invoice doc properly (like load_invoice does)
		// Start with a proper structure that will be updated by add_item
		this.invoice_doc = {
			company: data.company || this.pos_profile.company,
			customer: data.customer,
			currency: data.currency || this.pos_profile.currency,
			sales_order: data.sales_order,
			advances: [],  // Initialize advances array
		};
		
		// Load items from sales order using normal item addition
		if (data.items && data.items.length > 0) {
			this.items = [];
			for (const itemData of data.items) {
				// Prepare item data for add_item
				const item = {
					item_code: itemData.item_code,
					item_name: itemData.item_name,
					qty: itemData.qty || 1,
					rate: itemData.rate || 0,
					uom: itemData.uom || itemData.stock_uom || "Nos",
					stock_uom: itemData.stock_uom || itemData.uom || "Nos",
					warehouse: itemData.warehouse || this.pos_profile.warehouse,
					sales_order: itemData.sales_order || data.sales_order,
					so_detail: itemData.so_detail,  // Store so_detail for linking
				};
				// add_item will fetch full item details automatically
				await this.add_item(item);
			}
			
			// After all items added, wait for rendering
			await this.$nextTick();
			
			// Get the complete invoice doc with all items
			const doc = this.get_invoice_doc();
			
			// Ensure doc has all required fields before calling update_invoice
			doc.sales_order = data.sales_order;
			doc.company = data.company || this.pos_profile.company;
			doc.customer = data.customer;
			doc.currency = data.currency || this.pos_profile.currency;
			
			// Call update_invoice to calculate totals in backend
			// Pass the doc with items to get proper calculations
			await this.update_invoice(doc);
			
			// Update store to ensure reactivity
			if (this.invoiceStore && this.invoiceStore.setInvoiceDoc) {
				this.invoiceStore.setInvoiceDoc({
					...this.invoice_doc,
					sales_order: data.sales_order,
					advances: []
				});
			}
		}
		
		// Ensure sales_order and advances are set on invoice_doc after items are added
		// Use Vue.set for reactivity if available
		if (data.sales_order && this.invoice_doc) {
			if (this.$set) {
				this.$set(this.invoice_doc, 'sales_order', data.sales_order);
				if (!this.invoice_doc.advances) {
					this.$set(this.invoice_doc, 'advances', []);
				}
			} else {
				this.invoice_doc.sales_order = data.sales_order;
				if (!this.invoice_doc.advances) {
					this.invoice_doc.advances = [];
				}
			}
		}
		
		// Set advances in invoice_doc if sales order exists (always check, like customer credit)
	// Wait for invoice to be fully calculated before setting advances
	if (data.sales_order) {
		// Wait for invoice calculation to complete (items added, totals calculated)
			await this.$nextTick();
			
			// Fetch advance payment entries for this sales order
			this.fetch_and_set_advances(data.sales_order);
			
			// Force update to ensure UI reflects changes
			this.$nextTick(() => {
				this.$forceUpdate();
				// Emit event to ensure summary panel updates
				if (this.eventBus) {
					this.eventBus.emit('invoice_doc_updated');
				}
			});
		}
		
		// Focus on item search
		this.eventBus.emit("focus_item_search");
	},

	// Start a new order (or return order) with provided data
	async new_order(data = {}) {
		let old_invoice = null;
		this.expanded = [];
		this.posa_offers = [];
		this.eventBus.emit("set_pos_coupons", []);
		this.posa_coupons = [];
		this.return_doc = "";
		if (!data.name && !data.is_return) {
			this.items = [];
			this.customer = this.pos_profile.customer;
			// Clear all customer preservation flags when starting fresh invoice
			this._customerFromSalesOrder = null;
			this._savedInvoiceCustomer = null;
			this.invoice_doc = "";
			this.discount_amount = 0;
			this.additional_discount_percentage = 0;
			this.invoiceType = "Invoice";
			this.invoiceTypes = ["Invoice", "Order", "Quotation"];
		} else {
			if (data.is_return) {
				this.invoiceType = "Return";
				this.invoiceTypes = ["Return"];
				// Clear customer preservation flags for return invoices
				this._customerFromSalesOrder = null;
				this._savedInvoiceCustomer = null;
			}
			this.invoice_doc = data;
			this.items = data.items;
			this.update_items_details(this.items);
			this.posa_offers = data.posa_offers || [];
			this.items.forEach((item) => {
				if (!item.posa_row_id) {
					item.posa_row_id = this.makeid(20);
				}
				// Only set batch_qty if batch_no_data is available (to avoid errors during invoice reload)
				if (item.batch_no && item.batch_no_data && Array.isArray(item.batch_no_data) && item.batch_no_data.length > 0) {
					this.set_batch_qty(item, item.batch_no);
				} else if (item.batch_no) {
					// Just set the batch_no value without processing batch data
					// The batch data will be loaded later via update_items_details
					item.batch_no = item.batch_no;
				}
			});
			// When loading an invoice from backend (has name), always use the invoice's customer
			// When creating a new invoice (no name), preserve the selected customer from store
			// Exception: Return invoices ALWAYS use data.customer (from original invoice)
			if (data.is_return && data.customer) {
				// Return invoice - ALWAYS use the customer from the original invoice
				this.customer = data.customer;
				if (this.customersStore) {
					this.customersStore.setSelectedCustomer(data.customer);
				}
			} else if (data.name) {
				// Existing invoice from backend - use invoice's customer directly
				this.customer = data.customer;
				// Set persistent flag to preserve this customer through clearInvoice calls
				this._savedInvoiceCustomer = data.customer;
				if (this.customersStore && data.customer) {
					this.customersStore.setSelectedCustomer(data.customer);
				}
			} else {
				// New invoice - preserve selected customer from store if available
				const currentCustomer = this.customersStore?.selectedCustomer || this.customer;
				if (data.customer && !currentCustomer) {
					this.customer = data.customer;
					if (this.customersStore) {
						this.customersStore.setSelectedCustomer(data.customer);
					}
				} else if (currentCustomer) {
					// Preserve the current customer from store
					this.customer = currentCustomer;
				} else {
					this.customer = data.customer;
				}
			}
			this.posting_date = this.formatDateForBackend(data.posting_date || frappe.datetime.nowdate());
			this.discount_amount = data.discount_amount;
			this.additional_discount_percentage = data.additional_discount_percentage;
			this.items.forEach((item) => {
				if (item.serial_no) {
					item.serial_no_selected = [];
					const serial_list = item.serial_no.split("\n");
					serial_list.forEach((element) => {
						if (element.length) {
							item.serial_no_selected.push(element);
						}
					});
					item.serial_no_selected_count = item.serial_no_selected.length;
				}
			});
		}
		return old_invoice;
	},

	// Build the invoice document object for backend submission
	get_invoice_doc() {
		let doc = {};
		const sourceDoc = this.invoice_doc || {};

		// Safety check: ensure pos_profile exists, try to get it from various sources
		if (!this.pos_profile) {
			// Try to get from frappe.boot
			if (frappe?.boot?.pos_profile) {
				this.pos_profile = frappe.boot.pos_profile;
				console.warn("Using pos_profile from frappe.boot");
				// Emit event to notify other components that profile is restored
				if (this.eventBus) {
					this.eventBus.emit("register_pos_profile", {
						pos_profile: this.pos_profile,
					});
				}
			}
			// Try to get from cached opening storage
			else {
				try {
					const cached = getOpeningStorage();
					if (cached && cached.pos_profile) {
						this.pos_profile = cached.pos_profile;
						console.warn("Using pos_profile from cached opening storage");
						// Emit event to notify other components that profile is restored
						if (this.eventBus) {
							this.eventBus.emit("register_pos_profile", {
								pos_profile: this.pos_profile,
							});
						}
					}
				} catch (e) {
					console.error("Failed to get pos_profile from cache:", e);
				}
			}
			
			// If still not available, log error and return minimal doc
			if (!this.pos_profile) {
				console.error("pos_profile is not available. Cannot create invoice doc.");
				// Return a minimal doc structure to prevent further errors
				return {
					doctype: "Sales Invoice",
					is_pos: 1,
					ignore_pricing_rule: 1,
					items: [],
					payments: [],
				};
			}
		}
		
		// Ensure items array is properly initialized in the store
		if (this.invoiceStore && !Array.isArray(this.invoiceStore.items)) {
			this.invoiceStore.setItems([]);
		}
		
		// Ensure stock_settings is properly initialized
		if (!this.stock_settings || typeof this.stock_settings !== 'object') {
			// Try to get stock_settings from cached opening storage
			let cachedStockSettings = null;
			try {
				const cached = getOpeningStorage();
				if (cached && cached.stock_settings) {
					cachedStockSettings = cached.stock_settings;
				}
			} catch (e) {
				// Ignore cache errors
			}
			
			this.stock_settings = cachedStockSettings || {
				allow_negative_stock: false,
			};
		}
		
		// Ensure pos_opening_shift is properly initialized
		if (!this.pos_opening_shift) {
			// Try to get pos_opening_shift from cached opening storage
			try {
				const cached = getOpeningStorage();
				if (cached) {
					// pos_opening_shift might be in the cached data directly or nested
					if (cached.pos_opening_shift) {
						this.pos_opening_shift = cached.pos_opening_shift;
					} else if (cached.pos_opening_shift_name) {
						// If only the name is stored, create a minimal object
						this.pos_opening_shift = { name: cached.pos_opening_shift_name };
					}
				}
			} catch (e) {
				// Ignore cache errors
			}
		}
		
		// Final safety check - ensure pos_opening_shift is an object with name property if it exists
		if (this.pos_opening_shift && typeof this.pos_opening_shift !== 'object') {
			// If it's just a string (name), convert to object
			if (typeof this.pos_opening_shift === 'string') {
				this.pos_opening_shift = { name: this.pos_opening_shift };
			} else {
				// If it's something else unexpected, set to null
				this.pos_opening_shift = null;
			}
		}

		if (sourceDoc.name) {
			doc = { ...sourceDoc };
		}

		// Always set these fields first
		if (this.invoiceType === "Quotation") {
			doc.doctype = "Quotation";
		} else if (this.invoiceType === "Order" && this.pos_profile?.posa_create_only_sales_order) {
			doc.doctype = "Sales Order";
		} else if (this.pos_profile?.create_pos_invoice_instead_of_sales_invoice) {
			doc.doctype = "POS Invoice";
		} else {
			doc.doctype = "Sales Invoice";
		}
		doc.is_pos = 1;
		doc.ignore_pricing_rule = 1;
		doc.company = doc.company || this.pos_profile?.company;
		doc.pos_profile = doc.pos_profile || this.pos_profile?.name;
		doc.posa_show_custom_name_marker_on_print = this.pos_profile?.posa_show_custom_name_marker_on_print || 0;

		// Currency related fields
		doc.currency = this.selected_currency || this.pos_profile?.currency;
		doc.conversion_rate = (sourceDoc && sourceDoc.conversion_rate) || this.conversion_rate || 1;

		// Use actual price list currency if available
		doc.price_list_currency = this.price_list_currency || doc.currency;

		doc.plc_conversion_rate =
			(sourceDoc && sourceDoc.plc_conversion_rate) ||
			(doc.price_list_currency === doc.currency ? 1 : this.exchange_rate);

		// Other fields
		doc.campaign = doc.campaign || this.pos_profile?.campaign;
		doc.selling_price_list = this.pos_profile?.selling_price_list;
		doc.naming_series = doc.naming_series || this.pos_profile?.naming_series;
		doc.customer = this.customer;

		// Determine if this is a return invoice
		const isReturn = this.isReturnInvoice;
		doc.is_return = isReturn ? 1 : 0;

		// Calculate amounts in selected currency
		const items = this.get_invoice_items();
		doc.items = items;
		doc.packed_items = (this.packed_items || []).map((pi) => ({
			parent_item: pi.parent_item,
			item_code: pi.item_code,
			item_name: pi.item_name,
			qty: flt(pi.qty),
			uom: pi.uom,
			warehouse: pi.warehouse,
			batch_no: pi.batch_no,
			serial_no: pi.serial_no,
			rate: flt(pi.rate),
		}));

		// Calculate totals in selected currency ensuring negative values for returns
		let total = this.Total;
		if (isReturn && total > 0) total = -Math.abs(total);

		doc.total = total;
		doc.net_total = total; // Will adjust later if taxes are inclusive
		doc.base_total = total * (this.exchange_rate || 1);
		doc.base_net_total = total * (this.exchange_rate || 1);

		// Apply discounts with correct sign for returns
		let discountAmount = flt(this.additional_discount);
		if (isReturn && discountAmount > 0) discountAmount = -Math.abs(discountAmount);

		doc.discount_amount = discountAmount;
		doc.base_discount_amount = discountAmount * (this.exchange_rate || 1);

		let discountPercentage = flt(this.additional_discount_percentage);
		if (isReturn && discountPercentage > 0) discountPercentage = -Math.abs(discountPercentage);

		doc.additional_discount_percentage = discountPercentage;

		// Calculate grand total with correct sign for returns
		let grandTotal = this.subtotal;

		// Prepare taxes array
		doc.taxes = [];
		if (this.invoice_doc && this.invoice_doc.taxes) {
			let totalTax = 0;
			this.invoice_doc.taxes.forEach((tax) => {
				if (tax.tax_amount) {
					grandTotal += flt(tax.tax_amount);
					totalTax += flt(tax.tax_amount);
				}
				doc.taxes.push({
					account_head: tax.account_head,
					charge_type: tax.charge_type || "On Net Total",
					description: tax.description,
					rate: tax.rate,
					included_in_print_rate: tax.included_in_print_rate || 0,
					tax_amount: tax.tax_amount,
					total: tax.total,
					base_tax_amount: tax.tax_amount * (this.exchange_rate || 1),
					base_total: tax.total * (this.exchange_rate || 1),
				});
			});
			doc.total_taxes_and_charges = totalTax;
		} else if (isOffline()) {
			const tmpl = getTaxTemplate(this.pos_profile?.taxes_and_charges);
			if (tmpl && Array.isArray(tmpl.taxes)) {
				const inclusive = getTaxInclusiveSetting();
				let runningTotal = grandTotal;
				let totalTax = 0;
				tmpl.taxes.forEach((row) => {
					let tax_amount = 0;
					if (row.charge_type === "Actual") {
						tax_amount = flt(row.tax_amount || 0);
					} else if (inclusive) {
						tax_amount = flt((doc.total * flt(row.rate)) / 100);
					} else {
						tax_amount = flt((doc.net_total * flt(row.rate)) / 100);
					}
					if (!inclusive) {
						runningTotal += tax_amount;
					}
					totalTax += tax_amount;
					doc.taxes.push({
						account_head: row.account_head,
						charge_type: row.charge_type || "On Net Total",
						description: row.description,
						rate: row.rate,
						included_in_print_rate: row.charge_type === "Actual" ? 0 : inclusive ? 1 : 0,
						tax_amount: tax_amount,
						total: runningTotal,
						base_tax_amount: tax_amount * (this.exchange_rate || 1),
						base_total: runningTotal * (this.exchange_rate || 1),
					});
				});
				if (inclusive) {
					doc.net_total = doc.total - totalTax;
					doc.base_net_total = doc.net_total * (this.exchange_rate || 1);
					grandTotal = doc.total;
				} else {
					grandTotal = runningTotal;
				}
				doc.total_taxes_and_charges = totalTax;
			}
		}

		if (isReturn && grandTotal > 0) grandTotal = -Math.abs(grandTotal);

		doc.grand_total = grandTotal;
		doc.base_grand_total = grandTotal * (this.exchange_rate || 1);

		// Apply rounding to get rounded total unless disabled in POS Profile
		if (this.pos_profile?.disable_rounded_total) {
			doc.rounded_total = flt(grandTotal, this.currency_precision);
			doc.base_rounded_total = flt(doc.base_grand_total, this.currency_precision);
		} else {
			doc.rounded_total = this.roundAmount(grandTotal);
			doc.base_rounded_total = this.roundAmount(doc.base_grand_total);
		}

		// Add POS specific fields
		// Safely get pos_opening_shift name with multiple fallbacks
		let openingShiftName = null;
		if (this.pos_opening_shift) {
			if (typeof this.pos_opening_shift === 'object' && this.pos_opening_shift.name) {
				openingShiftName = this.pos_opening_shift.name;
			} else if (typeof this.pos_opening_shift === 'string') {
				openingShiftName = this.pos_opening_shift;
			}
		}
		doc.posa_pos_opening_shift = openingShiftName;
		
		// Add sales order reference and advance paid if loading from sales order
		if (this.sales_order_name) {
			doc.sales_order = this.sales_order_name;
			doc.advance_paid = this.sales_order_advance_paid || 0;
		}
		
		doc.payments = this.get_payments();

		// Handle return specific fields
		if (isReturn && this.invoice_doc) {
			if (this.invoice_doc.return_against) {
				doc.return_against = this.invoice_doc.return_against;
			}
			// Include custom_return_reason if provided (for Sales Invoice returns)
			if (this.invoice_doc.custom_return_reason) {
				doc.custom_return_reason = this.invoice_doc.custom_return_reason;
			}
			doc.update_stock = 1;

			// Double-check all values are negative
			if (doc.grand_total > 0) doc.grand_total = -Math.abs(doc.grand_total);
			if (doc.base_grand_total > 0) doc.base_grand_total = -Math.abs(doc.base_grand_total);
			if (doc.rounded_total > 0) doc.rounded_total = -Math.abs(doc.rounded_total);
			if (doc.base_rounded_total > 0) doc.base_rounded_total = -Math.abs(doc.base_rounded_total);
			if (doc.total > 0) doc.total = -Math.abs(doc.total);
			if (doc.base_total > 0) doc.base_total = -Math.abs(doc.base_total);
			if (doc.net_total > 0) doc.net_total = -Math.abs(doc.net_total);
			if (doc.base_net_total > 0) doc.base_net_total = -Math.abs(doc.base_net_total);

			// Ensure payments have negative amounts
			if (doc.payments && doc.payments.length) {
				doc.payments.forEach((payment) => {
					if (payment.amount > 0) payment.amount = -Math.abs(payment.amount);
					if (payment.base_amount > 0) payment.base_amount = -Math.abs(payment.base_amount);
				});
			}
		}

		// Add offer details
		doc.posa_offers = this.posa_offers;
		doc.posa_coupons = this.posa_coupons;
		doc.posa_delivery_charges = this.selected_delivery_charge?.name || null;
		doc.posa_delivery_charges_rate = this.delivery_charges_rate || 0;
		doc.posting_date = this.formatDateForBackend(this.posting_date_display);

		// Add flags to ensure proper rate handling
		doc.ignore_pricing_rule = 1;

		// Preserve the real price list currency
		doc.price_list_currency = this.price_list_currency || doc.currency;
		doc.plc_conversion_rate = this.exchange_rate || doc.conversion_rate;
		doc.ignore_default_fields = 1; // Add this to prevent default field updates

		// Add custom fields to track offer rates
		doc.posa_is_offer_applied = this.posa_offers.length > 0 ? 1 : 0;

		// Calculate base amounts using the exchange rate
		const baseCurrency = this.price_list_currency || this.pos_profile.currency;
		if (this.selected_currency !== baseCurrency) {
			// For returns, we need to ensure negative values
			const multiplier = isReturn ? -1 : 1;

			// Convert amounts back to the base currency
			doc.base_total = (total / this.exchange_rate) * multiplier;
			doc.base_net_total = (total / this.exchange_rate) * multiplier;
			doc.base_discount_amount = (discountAmount / this.exchange_rate) * multiplier;
			doc.base_grand_total = (grandTotal / this.exchange_rate) * multiplier;
			doc.base_rounded_total = (grandTotal / this.exchange_rate) * multiplier;
		} else {
			// Same currency, just ensure negative values for returns
			const multiplier = isReturn ? -1 : 1;
			// When in base currency, the base amounts are the same as the regular amounts
			doc.base_total = total * multiplier;
			doc.base_net_total = total * multiplier;
			doc.base_discount_amount = discountAmount * multiplier;
			doc.base_grand_total = grandTotal * multiplier;
			doc.base_rounded_total = grandTotal * multiplier;
		}

		// Ensure payments have correct base amounts
		if (doc.payments && doc.payments.length) {
			doc.payments.forEach((payment) => {
				if (this.selected_currency !== baseCurrency) {
					// Convert payment amount to base currency
					payment.base_amount = payment.amount / this.exchange_rate;
				} else {
					payment.base_amount = payment.amount;
				}

				// For returns, ensure negative values
				if (isReturn) {
					payment.amount = -Math.abs(payment.amount);
					payment.base_amount = -Math.abs(payment.base_amount);
				}
			});
		}

		return doc;
	},

	// Get invoice doc from order doc (for sales order to invoice conversion)
	async get_invoice_from_order_doc() {
		let doc = {};
		if (this.invoice_doc.doctype == "Sales Order") {
			await frappe.call({
				method: "posawesome.posawesome.api.invoices.create_sales_invoice_from_order",
				args: {
					sales_order: this.invoice_doc.name,
				},
				// async: false,
				callback: function (r) {
					if (r.message) {
						doc = r.message;
					}
				},
			});
		} else {
			doc = this.invoice_doc;
		}
		const Items = [];
		const updatedItemsData = this.get_invoice_items();
		doc.items.forEach((item) => {
			const updatedData = updatedItemsData.find(
				(updatedItem) => updatedItem.item_code === item.item_code,
			);
			if (updatedData) {
				item.item_code = updatedData.item_code;
				item.posa_row_id = updatedData.posa_row_id;
				item.posa_offers = updatedData.posa_offers;
				item.posa_offer_applied = updatedData.posa_offer_applied;
				item.posa_is_offer = updatedData.posa_is_offer;
				item.posa_is_replace = updatedData.posa_is_replace;
				item.is_free_item = updatedData.is_free_item;
				item.qty = flt(updatedData.qty);
				item.rate = flt(updatedData.rate);
				item.uom = updatedData.uom;
				item.amount = flt(updatedData.qty) * flt(updatedData.rate);
				item.conversion_factor = updatedData.conversion_factor;
				item.serial_no = updatedData.serial_no;
				item.discount_percentage = flt(updatedData.discount_percentage);
				item.discount_amount = flt(updatedData.discount_amount);
				item.batch_no = updatedData.batch_no;
				item.posa_notes = updatedData.posa_notes;
				item.posa_delivery_date = this.formatDateForDisplay(updatedData.posa_delivery_date);
				item.price_list_rate = updatedData.price_list_rate;
				Items.push(item);
			}
		});

		doc.items = Items;
		const newItems = [...doc.items];
		const existingItemCodes = new Set(newItems.map((item) => item.item_code));
		updatedItemsData.forEach((updatedItem) => {
			if (!existingItemCodes.has(updatedItem.item_code)) {
				newItems.push(updatedItem);
			}
		});
		doc.items = newItems;
		doc.update_stock = 1;
		doc.is_pos = 1;
		doc.payments = this.get_payments();
		return doc;
	},

	// Prepare items array for invoice doc
	get_invoice_items() {
		const items_list = [];
		const isReturn = this.isReturnInvoice;
		const usesPosInvoice = this.pos_profile.create_pos_invoice_instead_of_sales_invoice;

		this.items.forEach((item) => {
			const new_item = {
				item_code: item.item_code,
				// Retain the item name for offline invoices
				// Fallback to item_code if item_name is not available
				item_name: item.item_name || item.item_code,
				name_overridden: item.name_overridden ? 1 : 0,
				posa_row_id: item.posa_row_id,
				posa_offers: item.posa_offers,
				posa_offer_applied: item.posa_offer_applied,
				posa_is_offer: item.posa_is_offer,
				posa_is_replace: item.posa_is_replace,
				is_free_item: item.is_free_item,
				qty: flt(item.qty),
				uom: item.uom,
				conversion_factor: item.conversion_factor,
				serial_no: item.serial_no,
				// Link to original invoice item when doing returns
				// Needed for backend validation that the item exists in
				// the referenced Sales or POS Invoice
				...(item.sales_invoice_item && { sales_invoice_item: item.sales_invoice_item }),
				...(item.pos_invoice_item && { pos_invoice_item: item.pos_invoice_item }),
				discount_percentage: flt(item.discount_percentage),
				batch_no: item.batch_no,
				posa_notes: item.posa_notes,
				posa_delivery_date: this.formatDateForBackend(item.posa_delivery_date),
			};
			if (isReturn) {
				const refField = usesPosInvoice ? "pos_invoice_item" : "sales_invoice_item";
				if (!new_item[refField] && item.name) {
					new_item[refField] = item.name;
				}
			}

			// Handle currency conversion for rates and amounts
			const baseCurrency = this.price_list_currency || this.pos_profile.currency;
			if (this.selected_currency !== baseCurrency) {
				// If exchange rate is 300 PKR = 1 USD
				// item.rate is in USD (e.g. 10 USD)
				// base_rate should be in PKR (e.g. 3000 PKR)
				new_item.rate = flt(item.rate); // Keep rate in USD

				// Use pre-stored base_rate if available, otherwise calculate
				new_item.base_rate = item.base_rate || flt(item.rate / this.exchange_rate);

				new_item.price_list_rate = flt(item.price_list_rate); // Keep price list rate in USD
				new_item.base_price_list_rate =
					item.base_price_list_rate ?? flt(item.price_list_rate / this.exchange_rate);

				// Calculate amounts
				new_item.amount = flt(item.qty) * new_item.rate; // Amount in USD
				new_item.base_amount = new_item.amount / this.exchange_rate; // Convert to base currency

				// Handle discount amount
				new_item.discount_amount = flt(item.discount_amount); // Keep discount in USD
				new_item.base_discount_amount =
					item.base_discount_amount || flt(item.discount_amount / this.exchange_rate);
			} else {
				// Same currency (base currency), make sure we use base rates if available
				new_item.rate = flt(item.rate);
				new_item.base_rate = item.base_rate || flt(item.rate);
				new_item.price_list_rate = flt(item.price_list_rate);
				new_item.base_price_list_rate = item.base_price_list_rate ?? flt(item.price_list_rate);
				new_item.amount = flt(item.qty) * new_item.rate;
				new_item.base_amount = new_item.amount;
				new_item.discount_amount = flt(item.discount_amount);
				new_item.base_discount_amount = item.base_discount_amount || flt(item.discount_amount);
			}

			// For returns, ensure all amounts are negative
			if (isReturn) {
				new_item.qty = -Math.abs(new_item.qty);
				new_item.amount = -Math.abs(new_item.amount);
				new_item.base_amount = -Math.abs(new_item.base_amount);
				new_item.discount_amount = -Math.abs(new_item.discount_amount);
				new_item.base_discount_amount = -Math.abs(new_item.base_discount_amount);
			}
			
			// Add sales order linking if available
			if (item.sales_order) {
				new_item.sales_order = item.sales_order;
			}
			if (item.so_detail) {
				new_item.so_detail = item.so_detail;
			}

			items_list.push(new_item);
		});

		return items_list;
	},

	// Prepare items array for order doc
	get_order_items() {
		const items_list = [];
		this.items.forEach((item) => {
			const new_item = {
				item_code: item.item_code,
				// Retain item name to show on offline order documents
				// Use item_code if item_name is missing
				item_name: item.item_name || item.item_code,
				name_overridden: item.name_overridden ? 1 : 0,
				posa_row_id: item.posa_row_id,
				posa_offers: item.posa_offers,
				posa_offer_applied: item.posa_offer_applied,
				posa_is_offer: item.posa_is_offer,
				posa_is_replace: item.posa_is_replace,
				is_free_item: item.is_free_item,
				qty: flt(item.qty),
				rate: flt(item.rate),
				uom: item.uom,
				amount: flt(item.qty) * flt(item.rate),
				conversion_factor: item.conversion_factor,
				serial_no: item.serial_no,
				discount_percentage: flt(item.discount_percentage),
				discount_amount: flt(item.discount_amount),
				batch_no: item.batch_no,
				posa_notes: item.posa_notes,
				posa_delivery_date: item.posa_delivery_date,
				price_list_rate: item.price_list_rate,
			};
			items_list.push(new_item);
		});

		return items_list;
	},

	// Prepare payments array for invoice doc
	get_payments() {
		const payments = [];
		// Use this.subtotal which is already in selected currency and includes all calculations
		const total_amount = this.subtotal;
		let remaining_amount = total_amount;

		// Safety check: ensure pos_profile.payments exists and is an array
		const profilePayments = (this.pos_profile && this.pos_profile.payments) || [];
		if (!Array.isArray(profilePayments)) {
			console.warn("pos_profile.payments is not an array, using empty array");
			return payments;
		}

		profilePayments.forEach((payment, index) => {
			// For the first payment method, assign the full remaining amount
			const payment_amount = index === 0 ? remaining_amount : payment.amount || 0;

			// For return invoices, ensure payment amounts are negative
			const adjusted_amount = this.isReturnInvoice ? -Math.abs(payment_amount) : payment_amount;

			// Handle currency conversion
			// If selected_currency is USD and base is PKR:
			// amount is in USD (e.g. 10 USD)
			// base_amount should be in PKR (e.g. 3000 PKR)
			// So multiply by exchange rate to get base_amount
			const baseCurrency = this.price_list_currency || this.pos_profile?.currency;
			const base_amount =
				this.selected_currency !== baseCurrency
					? this.flt(adjusted_amount / (this.exchange_rate || 1), this.currency_precision)
					: adjusted_amount;

			payments.push({
				amount: adjusted_amount, // Keep in selected currency (e.g. USD)
				base_amount: base_amount, // Convert to base currency (e.g. PKR)
				mode_of_payment: payment.mode_of_payment,
				default: payment.default,
				account: payment.account || "",
				type: payment.type || "Cash",
				currency: this.selected_currency || this.pos_profile?.currency,
				conversion_rate: this.conversion_rate || 1,
			});

			remaining_amount -= payment_amount;
		});

		console.log("Generated payments:", {
			currency: this.selected_currency,
			exchange_rate: this.exchange_rate,
			payments: payments.map((p) => ({
				mode: p.mode_of_payment,
				amount: p.amount,
				base_amount: p.base_amount,
			})),
		});

		return payments;
	},

	// Convert amount to selected currency
	convert_amount(amount) {
		const baseCurrency = this.price_list_currency || this.pos_profile.currency;
		if (this.selected_currency === baseCurrency) {
			return amount;
		}
		return this.flt(amount * this.exchange_rate, this.currency_precision);
	},

	// Update invoice in backend
	async update_invoice(doc) {
		if (isOffline()) {
			// When offline, simply merge the passed doc with the current invoice_doc
			// to allow offline invoice creation without server calls
			this.invoice_doc = Object.assign({}, this.invoice_doc || {}, doc);
			return this.invoice_doc;
		}

		const method =
			doc.doctype === "Sales Order" && this.pos_profile.posa_create_only_sales_order
				? "posawesome.posawesome.api.sales_orders.update_sales_order"
				: doc.doctype === "Quotation"
					? "posawesome.posawesome.api.quotations.update_quotation"
					: "posawesome.posawesome.api.invoices.update_invoice";

		try {
			const response = await frappe.call({
				method,
				args: {
					data: doc,
				},
			});

			const message = response?.message;
			if (message) {
				this.invoice_doc = message;
				if (message.exchange_rate_date) {
					this.exchange_rate_date = message.exchange_rate_date;
					const posting_backend = this.formatDateForBackend(this.posting_date_display);
					if (posting_backend !== this.exchange_rate_date) {
						this.eventBus.emit("show_message", {
							title: __(
								"Exchange rate date " +
									this.exchange_rate_date +
									" differs from posting date " +
									posting_backend,
							),
							color: "warning",
						});
					}
				}
			}

			return this.invoice_doc;
		} catch (error) {
			console.error("Error updating invoice:", error);
			throw error;
		}
	},

	// Update invoice from order in backend
	async update_invoice_from_order(doc) {
		if (isOffline()) {
			// Offline mode - merge doc locally without server update
			this.invoice_doc = Object.assign({}, this.invoice_doc || {}, doc);
			return this.invoice_doc;
		}

		try {
			const response = await frappe.call({
				method: "posawesome.posawesome.api.invoices.update_invoice_from_order",
				args: {
					data: doc,
				},
			});

			const message = response?.message;
			if (message) {
				this.invoice_doc = message;
				if (message.exchange_rate_date) {
					this.exchange_rate_date = message.exchange_rate_date;
					const posting_backend = this.formatDateForBackend(this.posting_date_display);
					if (posting_backend !== this.exchange_rate_date) {
						this.eventBus.emit("show_message", {
							title: __(
								"Exchange rate date " +
									this.exchange_rate_date +
									" differs from posting date " +
									posting_backend,
							),
							color: "warning",
						});
					}
				}
			}

			return this.invoice_doc;
		} catch (error) {
			console.error("Error updating invoice from order:", error);
			throw error;
		}
	},

	// Process and save invoice (handles update or create)
	async process_invoice() {
		const doc = this.get_invoice_doc();
		try {
			const updated_doc = await this.update_invoice(doc);
			if (updated_doc && updated_doc.posting_date) {
				this.posting_date = this.formatDateForBackend(updated_doc.posting_date);
			}
			return updated_doc;
		} catch (error) {
			console.error("Error in process_invoice:", error);
			this.eventBus.emit("show_message", {
				title: __(error.message || "Error processing invoice"),
				color: "error",
			});
			return false;
		}
	},

	// Process and save invoice from order
	async process_invoice_from_order() {
		const doc = await this.get_invoice_from_order_doc();
		return this.update_invoice_from_order(doc);
	},

	// Apply available offers, save the invoice, and reload it from backend
	async apply_offers_and_reload() {
		try {
			if (!Array.isArray(this.items) || this.items.length === 0) {
				this.eventBus.emit("show_message", {
					title: __("Select items to apply offers"),
					color: "warning",
				});
				return;
			}

			// Recompute and apply offers for current items
			if (typeof this.handelOffers === "function") {
				await this.handelOffers();
			}

			// Persist invoice (server calculates totals/taxes)
			const updated = await this.process_invoice();
			if (!updated) {
				return;
			}

			// Reload same invoice from backend without selection UI
			if (!isOffline() && updated.name) {
				await this.reload_current_invoice_from_backend();
			}

			this.eventBus.emit("show_message", {
				title: __("Offers applied and invoice refreshed"),
				color: "success",
			});
		} catch (error) {
			console.error("Error in apply_offers_and_reload:", error);
			this.eventBus.emit("show_message", {
				title: __("Failed to apply offers"),
				color: "error",
			});
		}
	},

	// Reload the currently open invoice from the backend and load it into the UI
	async reload_current_invoice_from_backend() {
		try {
			if (isOffline()) {
				return null;
			}

			const current = this.invoice_doc || {};
			const name = current.name;
			const doctype =
				current.doctype ||
				(this.pos_profile?.create_pos_invoice_instead_of_sales_invoice
					? "POS Invoice"
					: "Sales Invoice");

			if (!name || !doctype) {
				return null;
			}

			const manualOverrides = this._collectManualRateOverrides(this.items);

			const r = await frappe.call({
				method: "frappe.client.get",
				args: { doctype, name },
			});

			const doc = r?.message;
			if (doc) {
				if (manualOverrides.length) {
					this._applyManualRateOverridesToDoc(doc, manualOverrides);
				}
				// Load invoice - the load_invoice function will use the invoice's customer
				// since it has a name (existing invoice from backend)
				await this.load_invoice(doc);
				return doc;
			}
			return null;
		} catch (error) {
			console.error("Error reloading current invoice from backend:", error);
			this.eventBus.emit("show_message", {
				title: __("Failed to reload invoice from server"),
				color: "warning",
			});
			return null;
		}
	},

	_collectManualRateOverrides(items) {
		if (!Array.isArray(items) || !items.length) {
			return [];
		}

		return items
			.filter((item) => item && item._manual_rate_set)
			.map((item) => ({
				keys: {
					name: item.name || null,
					posa_row_id: item.posa_row_id || null,
					item_code: item.item_code || null,
					idx: item.idx !== undefined && item.idx !== null ? Number(item.idx) : null,
					batch_no: item.batch_no || null,
					serial_no: item.serial_no || null,
				},
				values: {
					rate: item.rate,
					base_rate: item.base_rate,
					price_list_rate: item.price_list_rate,
					base_price_list_rate: item.base_price_list_rate,
					discount_amount: item.discount_amount,
					base_discount_amount: item.base_discount_amount,
					discount_percentage: item.discount_percentage,
					amount: item.amount,
					base_amount: item.base_amount,
					conversion_factor: item.conversion_factor,
					uom: item.uom,
				},
			}));
	},

	_doesManualOverrideMatchItem(override, item) {
		if (!override?.keys || !item) {
			return false;
		}

		const { name, posa_row_id, item_code, idx, batch_no, serial_no } = override.keys;

		if (name && item.name && name === item.name) {
			return true;
		}

		if (posa_row_id && item.posa_row_id && posa_row_id === item.posa_row_id) {
			return true;
		}

		if (item_code && item.item_code === item_code) {
			if (idx !== null && idx !== undefined) {
				const itemIdx = item.idx !== undefined && item.idx !== null ? Number(item.idx) : null;
				if (itemIdx !== null && itemIdx === idx) {
					return true;
				}
			}

			const batchMatch = (batch_no || null) === (item.batch_no || null);
			const serialMatch = (serial_no || null) === (item.serial_no || null);

			if (batchMatch && serialMatch) {
				return true;
			}
		}

		return false;
	},

	_assignManualOverrideValues(item, values = {}) {
		if (!item || !values) {
			return;
		}

		item._manual_rate_set = true;

		if (values.uom) {
			item.uom = values.uom;
		}
		if (values.conversion_factor !== undefined && values.conversion_factor !== null) {
			item.conversion_factor = values.conversion_factor;
		}

		if (values.price_list_rate !== undefined) {
			item.price_list_rate = values.price_list_rate;
		}
		if (values.base_price_list_rate !== undefined) {
			item.base_price_list_rate = values.base_price_list_rate;
		}
		if (values.rate !== undefined) {
			item.rate = values.rate;
		}
		if (values.base_rate !== undefined) {
			item.base_rate = values.base_rate;
		}
		if (values.discount_amount !== undefined) {
			item.discount_amount = values.discount_amount;
		}
		if (values.base_discount_amount !== undefined) {
			item.base_discount_amount = values.base_discount_amount;
		}
		if (values.discount_percentage !== undefined) {
			item.discount_percentage = values.discount_percentage;
		}

		if (values.amount !== undefined) {
			item.amount = values.amount;
		} else if (typeof item.qty === "number" && typeof item.rate === "number") {
			item.amount = this.flt(item.qty * item.rate, this.currency_precision);
		}

		if (values.base_amount !== undefined) {
			item.base_amount = values.base_amount;
		} else if (typeof item.qty === "number" && typeof item.base_rate === "number") {
			item.base_amount = this.flt(item.qty * item.base_rate, this.currency_precision);
		}
	},

	_applyManualRateOverridesToDoc(doc, overrides) {
		if (!doc || !Array.isArray(doc.items) || !Array.isArray(overrides) || !overrides.length) {
			return;
		}

		const remaining = [...overrides];

		doc.items.forEach((item) => {
			if (!item || !remaining.length) {
				return;
			}

			const index = remaining.findIndex((entry) => this._doesManualOverrideMatchItem(entry, item));
			if (index === -1) {
				return;
			}

			const override = remaining.splice(index, 1)[0];
			this._assignManualOverrideValues(item, override.values);
		});
	},

	_buildManualOverrideKeyFromItem(item) {
		if (!item) {
			return null;
		}

		const idx =
			item.idx !== undefined && item.idx !== null && !Number.isNaN(Number(item.idx))
				? Number(item.idx)
				: null;

		if (!item.name && !item.posa_row_id && !item.item_code) {
			return null;
		}

		return {
			name: item.name || null,
			posa_row_id: item.posa_row_id || null,
			item_code: item.item_code || null,
			idx,
			batch_no: item.batch_no || null,
			serial_no: item.serial_no || null,
		};
	},

	_snapshotManualValuesFromDocItems(items) {
		if (!Array.isArray(items) || !items.length) {
			return [];
		}

		const EPSILON = 0.000001;

		return items
			.map((item) => {
				const keys = this._buildManualOverrideKeyFromItem(item);
				if (!keys) {
					return null;
				}

				const rate = Number(item?.rate ?? 0);
				const priceListRate = Number(item?.price_list_rate ?? rate);
				const baseRate = Number(item?.base_rate ?? 0);
				const basePriceListRate = Number(item?.base_price_list_rate ?? baseRate);
				const discountAmount = Number(item?.discount_amount ?? 0);
				const baseDiscountAmount = Number(item?.base_discount_amount ?? 0);
				const discountPercentage = Number(item?.discount_percentage ?? 0);

				const preserveRate =
					item?._manual_rate_set === true ||
					Math.abs(rate - priceListRate) > EPSILON ||
					Math.abs(baseRate - basePriceListRate) > EPSILON ||
					Math.abs(discountAmount) > EPSILON ||
					Math.abs(baseDiscountAmount) > EPSILON ||
					Math.abs(discountPercentage) > EPSILON;

				const preserveUom = Boolean(item?.uom);

				return {
					keys,
					preserveRate,
					preserveUom,
					values: {
						rate: item.rate,
						base_rate: item.base_rate,
						price_list_rate: item.price_list_rate,
						base_price_list_rate: item.base_price_list_rate,
						discount_amount: item.discount_amount,
						base_discount_amount: item.base_discount_amount,
						discount_percentage: item.discount_percentage,
						amount: item.amount,
						base_amount: item.base_amount,
						conversion_factor: item.conversion_factor,
						uom: item.uom,
					},
				};
			})
			.filter((entry) => entry !== null);
	},

	_restoreManualSnapshots(items, snapshots) {
		if (!Array.isArray(items) || !Array.isArray(snapshots) || !snapshots.length) {
			return;
		}

		const remaining = [...snapshots];

		items.forEach((item) => {
			if (!item || !remaining.length) {
				return;
			}

			const index = remaining.findIndex((snapshot) =>
				this._doesManualOverrideMatchItem({ keys: snapshot.keys }, item),
			);

			if (index === -1) {
				return;
			}

			const snapshot = remaining.splice(index, 1)[0];
			const values = snapshot.values || {};

			if (snapshot.preserveRate) {
				this._assignManualOverrideValues(item, values);
			} else if (snapshot.preserveUom) {
				if (values.uom !== undefined) {
					item.uom = values.uom;
				}
				if (values.conversion_factor !== undefined && values.conversion_factor !== null) {
					item.conversion_factor = values.conversion_factor;
				}

				if (values.amount !== undefined) {
					item.amount = values.amount;
				} else if (typeof item.qty === "number" && typeof item.rate === "number") {
					item.amount = this.flt(item.qty * item.rate, this.currency_precision);
				}

				if (values.base_amount !== undefined) {
					item.base_amount = values.base_amount;
				} else if (typeof item.qty === "number" && typeof item.base_rate === "number") {
					item.base_amount = this.flt(item.qty * item.base_rate, this.currency_precision);
				}
			}
		});
	},

	// Show payment dialog after validation and processing
	async show_payment() {
		if (this._suppressClosePaymentsTimer) {
			clearTimeout(this._suppressClosePaymentsTimer);
			this._suppressClosePaymentsTimer = null;
		}
		this._suppressClosePayments = true;

		try {
			console.log("Starting show_payment process");
			console.log("Invoice state before payment:", {
				invoiceType: this.invoiceType,
				is_return: this.invoice_doc ? this.invoice_doc.is_return : false,
				items_count: this.items.length,
				customer: this.customer,
			});

			if (!this.customer) {
				console.log("Customer validation failed");
				this.eventBus.emit("show_message", {
					title: __(`Select a customer`),
					color: "error",
				});
				return;
			}

			// Sync customer to customer store before navigating to payments
			// This ensures the customer persists when navigating to the payments screen
			if (this.customer && this.customersStore) {
				this.customersStore.setSelectedCustomer(this.customer);
				console.log("Synced customer to store:", this.customer);
			}

			if (!this.items.length) {
				console.log("Items validation failed - no items");
				this.eventBus.emit("show_message", {
					title: __(`Select items to sell`),
					color: "error",
				});
				return;
			}

			console.log("Basic validations passed, proceeding to main validation");
			const isValid = this.validate();
			console.log("Main validation result:", isValid);

		if (!isValid) {
			console.log("Main validation failed");
			return;
		}

	// Save advances and sales_order BEFORE processing (from this.invoice_doc)
	const savedAdvances = this.invoice_doc && this.invoice_doc.advances ? [...this.invoice_doc.advances] : [];
	const savedSalesOrder = this.invoice_doc ? this.invoice_doc.sales_order : null;

		let invoice_doc;
		if (
			this.invoiceType === "Order" &&
			this.pos_profile.posa_create_only_sales_order &&
			!this.new_delivery_date &&
			!(this.invoice_doc && this.invoice_doc.posa_delivery_date)
		) {
			console.log("Building local Sales Order doc for payment");
			invoice_doc = this.get_invoice_doc();
		} else if (
			this.invoice_doc &&
			this.invoice_doc.doctype === "Sales Order" &&
			this.invoiceType === "Invoice"
		) {
			console.log("Processing Sales Order payment");
			invoice_doc = await this.process_invoice_from_order();
		} else {
			console.log("Processing regular invoice");
			invoice_doc = await this.process_invoice();
		}

		if (!invoice_doc) {
			console.log("Failed to process invoice");
			return;
		}

	// Reload current invoice from backend (no selection dialog) to ensure items/totals are up-to-date
	if (!isOffline() && invoice_doc.name) {
		const refreshed = await this.reload_current_invoice_from_backend();
		if (refreshed) {
			invoice_doc = refreshed;
		}
	}
	
	// Restore advances and sales_order after reload (using saved values from before processing)
	if (savedAdvances.length > 0) {
		invoice_doc.advances = savedAdvances;
		if (savedSalesOrder) {
			invoice_doc.sales_order = savedSalesOrder;
		}
		
		// Calculate total advance amount
		let total_advance = 0;
		for (const adv of savedAdvances) {
			total_advance += flt(adv.allocated_amount || 0);
		}
		
		// Update invoice_doc with restored advances and adjust payments
		this.invoice_doc = invoice_doc;
		
		// Adjust payment amount to show outstanding balance (invoice_total - advance)
		if (total_advance > 0) {
			const invoice_total = flt(invoice_doc.grand_total || invoice_doc.rounded_total || 0);
			const outstanding = flt(invoice_total - total_advance);
			
			// Set payment to outstanding balance
			if (invoice_doc.payments && invoice_doc.payments.length > 0) {
				invoice_doc.payments[0].amount = outstanding;
				if (invoice_doc.payments[0].base_amount !== undefined) {
					invoice_doc.payments[0].base_amount = outstanding;
				}
			}
		}
	}

			// Update invoice_doc with current currency info
			invoice_doc.currency = this.selected_currency || this.pos_profile.currency;
			invoice_doc.conversion_rate = this.conversion_rate || 1;
			invoice_doc.plc_conversion_rate = this.exchange_rate || 1;

			// Preserve totals calculated on the server to ensure taxes are included
			// The process_invoice method already updates the invoice with taxes and
			// totals via the backend. Overriding those values here caused the
			// payment dialog to display amounts without taxes applied. Simply use
			// the values returned from the server instead of recalculating them on
			// the client side.

			// Update totals on the client has been disabled. The original code is
			// kept below for reference and is intentionally commented out to avoid
			// overriding the server calculated values.
			// invoice_doc.total = this.Total;
			// invoice_doc.grand_total = this.subtotal;

			// if (this.pos_profile.disable_rounded_total) {
			//   invoice_doc.rounded_total = flt(this.subtotal, this.currency_precision);
			// } else {
			//   invoice_doc.rounded_total = this.roundAmount(this.subtotal);
			// }
			// invoice_doc.base_total = this.Total * (1 / this.exchange_rate || 1);
			// invoice_doc.base_grand_total = this.subtotal * (1 / this.exchange_rate || 1);
			// if (this.pos_profile.disable_rounded_total) {
			//   invoice_doc.base_rounded_total = flt(invoice_doc.base_grand_total, this.currency_precision);
			// } else {
			//   invoice_doc.base_rounded_total = this.roundAmount(invoice_doc.base_grand_total);
			// }

			// Check if this is a return invoice
			if (this.isReturnInvoice || invoice_doc.is_return) {
				console.log("Preparing RETURN invoice for payment with:", {
					is_return: invoice_doc.is_return,
					invoiceType: this.invoiceType,
					return_against: invoice_doc.return_against,
					items: invoice_doc.items.length,
					grand_total: invoice_doc.grand_total,
				});

				// For return invoices, explicitly ensure all amounts are negative
				invoice_doc.is_return = 1;
				if (invoice_doc.grand_total > 0) invoice_doc.grand_total = -Math.abs(invoice_doc.grand_total);
				if (invoice_doc.rounded_total > 0)
					invoice_doc.rounded_total = -Math.abs(invoice_doc.rounded_total);
				if (invoice_doc.total > 0) invoice_doc.total = -Math.abs(invoice_doc.total);
				if (invoice_doc.base_grand_total > 0)
					invoice_doc.base_grand_total = -Math.abs(invoice_doc.base_grand_total);
				if (invoice_doc.base_rounded_total > 0)
					invoice_doc.base_rounded_total = -Math.abs(invoice_doc.base_rounded_total);
				if (invoice_doc.base_total > 0) invoice_doc.base_total = -Math.abs(invoice_doc.base_total);

				// Ensure all items have negative quantity and amount
				if (invoice_doc.items && invoice_doc.items.length) {
					invoice_doc.items.forEach((item) => {
						if (item.qty > 0) item.qty = -Math.abs(item.qty);
						if (item.stock_qty > 0) item.stock_qty = -Math.abs(item.stock_qty);
						if (item.amount > 0) item.amount = -Math.abs(item.amount);
					});
				}
			}

		// Get payments with correct sign (positive/negative)
		invoice_doc.payments = this.get_payments();

		// Double-check return invoice payments are negative
		if ((this.isReturnInvoice || invoice_doc.is_return) && invoice_doc.payments.length) {
			invoice_doc.payments.forEach((payment) => {
				if (payment.amount > 0) payment.amount = -Math.abs(payment.amount);
				if (payment.base_amount > 0) payment.base_amount = -Math.abs(payment.base_amount);
			});
		}
		
		// Adjust payments for advances (must happen AFTER get_payments() to avoid being overwritten)
		if (invoice_doc.advances && invoice_doc.advances.length > 0) {
			let total_advance = 0;
			for (const adv of invoice_doc.advances) {
				total_advance += flt(adv.allocated_amount || 0);
			}
			
			if (total_advance > 0) {
				const invoice_total = flt(invoice_doc.grand_total || invoice_doc.rounded_total || 0);
				const outstanding = flt(invoice_total - total_advance);
				
				// Adjust first payment to outstanding balance
				if (invoice_doc.payments && invoice_doc.payments.length > 0) {
					invoice_doc.payments[0].amount = outstanding;
					if (invoice_doc.payments[0].base_amount !== undefined) {
						invoice_doc.payments[0].base_amount = outstanding;
					}
				}
			}
		}
			if (typeof this.paymentVisible !== "undefined") {
				this.paymentVisible = true;
			}
			this.eventBus.emit("show_payment", "true");
			this.eventBus.emit("send_invoice_doc_payment", invoice_doc);
		} catch (error) {
			console.error("Error in show_payment:", error);
			this.eventBus.emit("show_message", {
				title: __("Error processing payment"),
				color: "error",
				message: error.message,
			});
		} finally {
			this._suppressClosePaymentsTimer = setTimeout(() => {
				this._suppressClosePayments = false;
				this._suppressClosePaymentsTimer = null;
			}, 300);
		}
	},

	// Validate invoice before payment/submit (return logic, quantity, rates, etc)
	async validate() {
		console.log("Starting return validation");

		// For all returns, check if amounts are negative
		if (this.isReturnInvoice) {
			console.log("Validating return invoice values");

			// Check if quantities are negative
			const positiveItems = this.items.filter((item) => item.qty >= 0 || item.stock_qty >= 0);
			if (positiveItems.length > 0) {
				console.log(
					"Found positive quantities in return items:",
					positiveItems.map((i) => i.item_code),
				);
				this.eventBus.emit("show_message", {
					title: __(`Return items must have negative quantities`),
					color: "error",
				});

				// Fix the quantities to be negative
				positiveItems.forEach((item) => {
					item.qty = -Math.abs(item.qty);
					item.stock_qty = -Math.abs(item.stock_qty);
				});

				// Force update to reflect changes
				this.$forceUpdate();
			}

			// Ensure total amount is negative
			if (this.subtotal > 0) {
				console.log("Return has positive subtotal:", this.subtotal);
				this.eventBus.emit("show_message", {
					title: __(`Return total must be negative`),
					color: "warning",
				});
			}
		}

		// For return with reference to existing invoice
		const currentInvoice = this.invoice_doc;
		if (currentInvoice && currentInvoice.is_return && currentInvoice.return_against) {
			console.log("Return doc:", this.invoice_doc);
			console.log("Current items:", this.items);

			try {
				// Get original invoice items for comparison
				const original_items = await new Promise((resolve, reject) => {
					frappe.call({
						method: "frappe.client.get",
						args: {
							doctype: this.pos_profile.create_pos_invoice_instead_of_sales_invoice
								? "POS Invoice"
								: "Sales Invoice",
							name: currentInvoice.return_against,
						},
						callback: (r) => {
							if (r.message) {
								console.log("Original invoice data:", r.message);
								resolve(r.message.items || []);
							} else {
								reject(new Error("Original invoice not found"));
							}
						},
					});
				});

				console.log("Original invoice items:", original_items);
				console.log(
					"Original item codes:",
					original_items.map((item) => ({
						item_code: item.item_code,
						qty: item.qty,
						rate: item.rate,
					})),
				);

				// Validate each return item
				for (const item of this.items) {
					console.log("Validating return item:", {
						item_code: item.item_code,
						rate: item.rate,
						qty: item.qty,
					});

					// Normalize item codes by trimming and converting to uppercase
					const normalized_return_item_code = item.item_code.trim().toUpperCase();

					// Find matching item in original invoice
					const original_item = original_items.find(
						(orig) => orig.item_code.trim().toUpperCase() === normalized_return_item_code,
					);

					if (!original_item) {
						console.log("Item not found in original invoice:", {
							return_item_code: normalized_return_item_code,
							original_items: original_items.map((i) => i.item_code.trim().toUpperCase()),
						});

						this.eventBus.emit("show_message", {
							title: __(`Item ${item.item_code} not found in original invoice`),
							color: "error",
						});
						return false;
					}

					// Compare rates with precision
					const rate_diff = Math.abs(original_item.rate - item.rate);
					console.log("Rate comparison:", {
						return_rate: item.rate,
						orig_rate: original_item.rate,
						difference: rate_diff,
					});

					if (rate_diff > 0.01) {
						this.eventBus.emit("show_message", {
							title: __(`Rate mismatch for item ${item.item_code}`),
							color: "error",
						});
						return false;
					}

					// Compare quantities
					const return_qty = Math.abs(item.qty);
					const orig_qty = original_item.qty;
					console.log("Quantity comparison:", {
						return_qty: return_qty,
						orig_qty: orig_qty,
					});

					if (return_qty > orig_qty) {
						this.eventBus.emit("show_message", {
							title: __(
								`Return quantity cannot be greater than original quantity for item ${item.item_code}`,
							),
							color: "error",
						});
						return false;
					}
				}
			} catch (error) {
				console.error("Error in validation:", error);
				this.eventBus.emit("show_message", {
					title: __(`Error validating return: ${error.message}`),
					color: "error",
				});
				return false;
			}
		}
		return true;
	},

	// Get draft invoices from backend
	async get_draft_invoices() {
		try {
			const { message } = await frappe.call({
				method: "posawesome.posawesome.api.invoices.get_draft_invoices",
				args: {
					pos_opening_shift: (this.pos_opening_shift && typeof this.pos_opening_shift === 'object' && this.pos_opening_shift.name) 
						? this.pos_opening_shift.name 
						: (typeof this.pos_opening_shift === 'string' ? this.pos_opening_shift : null),
					doctype: this.pos_profile.create_pos_invoice_instead_of_sales_invoice
						? "POS Invoice"
						: "Sales Invoice",
				},
			});
			if (message) {
				this.eventBus.emit("open_drafts", message);
			}
		} catch (error) {
			console.error("Error fetching draft invoices:", error);
			this.eventBus.emit("show_message", {
				title: __("Unable to fetch draft invoices"),
				color: "error",
			});
		}
	},

	// Get draft orders from backend
	async get_draft_orders() {
		try {
			const { message } = await frappe.call({
				method: "posawesome.posawesome.api.sales_orders.search_orders",
				args: {
					company: this.pos_profile.company,
					currency: this.pos_profile.currency,
				},
			});
			if (message) {
				this.eventBus.emit("open_orders", message);
			}
		} catch (error) {
			console.error("Error fetching draft orders:", error);
			this.eventBus.emit("show_message", {
				title: __("Unable to fetch draft orders"),
				color: "error",
			});
		}
	},

	// Open returns dialog
	open_returns() {
		this.eventBus.emit("open_returns", this.pos_profile.company);
	},

	// Open minimal sales order dialog
	async open_minimal_sales_order() {
		try {
			const { message } = await frappe.call({
				method: "posawesome.posawesome.api.minimal_sales_orders.get_minimal_sales_order_defaults",
			});
			this.eventBus.emit("open_minimal_sales_order", {
				pos_profile: this.pos_profile,
				default_item: message?.default_item || null,
			});
		} catch (error) {
			console.error("Failed to open minimal sales order:", error);
			this.eventBus.emit("show_message", {
				title: __("Unable to open minimal sales order"),
				color: "error",
			});
		}
	},

	// Open minimal sales order list
	open_minimal_sales_order_list() {
		this.eventBus.emit("open_minimal_sales_order_list", {
			pos_profile: this.pos_profile,
		});
	},

	// Close payment dialog
	close_payments() {
		if (this._suppressClosePayments) {
			return;
		}

		if (typeof this.paymentVisible !== "undefined" && !this.paymentVisible) {
			return;
		}

		if (typeof this.paymentVisible !== "undefined") {
			this.paymentVisible = false;
		}

		this.eventBus.emit("show_payment", "false");
	},

	// Update details for all items (fetch from backend)
	async update_items_details(items) {
		if (!items?.length) return;
		if (!this.pos_profile) return;

		try {
			const response = await frappe.call({
				method: "posawesome.posawesome.api.items.get_items_details",
				args: {
					pos_profile: JSON.stringify(this.pos_profile),
					items_data: JSON.stringify(items),
					price_list: this.selected_price_list || this.pos_profile.selling_price_list,
				},
			});

			if (response?.message) {
				items.forEach((item) => {
					const updated_item = response.message.find(
						(element) => element.posa_row_id == item.posa_row_id,
					);
					if (updated_item) {
						// Freeze stock BEFORE updating, if freeze setting is enabled
						// This ensures we capture the original stock from backend before any reductions
						if (this.freezeStockQuantity && this.fatehPosSettings?.freeze_stock_during_entry && item?.item_code) {
							// Update item first with fresh stock from backend
							item.actual_qty = updated_item.actual_qty;
							item.item_uoms = updated_item.item_uoms;
							item.has_batch_no = updated_item.has_batch_no;
							item.has_serial_no = updated_item.has_serial_no;
							item.batch_no_data = updated_item.batch_no_data;
							item.serial_no_data = updated_item.serial_no_data;
							
							// Now freeze the fresh stock immediately (before stock coordinator reduces it)
							this.freezeStockQuantity(item);
						} else {
							item.actual_qty = updated_item.actual_qty;
							item.item_uoms = updated_item.item_uoms;
							item.has_batch_no = updated_item.has_batch_no;
							item.has_serial_no = updated_item.has_serial_no;
							item.batch_no_data = updated_item.batch_no_data;
							item.serial_no_data = updated_item.serial_no_data;
						}
						if (updated_item.rate !== undefined) {
							const force =
								this.pos_profile?.posa_force_price_from_customer_price_list !== false;
							const price = updated_item.price_list_rate ?? updated_item.rate ?? 0;
							const basePrice = updated_item.base_price_list_rate ?? updated_item.base_rate ?? price;
							const manualLocked = item._manual_rate_set === true;
							const shouldOverrideRate =
								!item.locked_price && !item.posa_offer_applied && !manualLocked;

							if (shouldOverrideRate) {
								if (force || price) {
									item.rate = price;
									item.price_list_rate = price;
									// Ensure base rate fields are also set
									item.base_rate = basePrice;
									item.base_price_list_rate = basePrice;
								}
							} else if (!item.price_list_rate && (force || price)) {
								item.price_list_rate = price;
								// Ensure base rate fields are also set
								if (!item.base_price_list_rate) {
									item.base_price_list_rate = basePrice;
								}
								if (!item.base_rate) {
									item.base_rate = basePrice;
								}
							}
						}
						if (updated_item.currency) {
							item.currency = updated_item.currency;
						}
					}
				});
			}
			
			// Fetch warehouse stock for items if configured in Fateh POS Settings
			if (this.fatehPosSettings?.warehouse_stock_warehouses && 
				Array.isArray(this.fatehPosSettings.warehouse_stock_warehouses) &&
				this.fatehPosSettings.warehouse_stock_warehouses.length > 0 &&
				this.fetchWarehouseStock) {
				items.forEach((item) => {
					if (item?.item_code) {
						this.fetchWarehouseStock(item);
					}
				});
			}
		} catch (error) {
			console.error("Error updating items:", error);
			this.eventBus.emit("show_message", {
				title: __("Error updating item details"),
				color: "error",
			});
		}
	},

	// Update details for a single item (fetch from backend)
	async update_item_detail(item, force_update = false) {
		return this.queueItemTask(
			item,
			"update_item_detail",
			() => this._performItemDetailUpdate(item, force_update),
			{ force: force_update },
		);
	},

	async _performItemDetailUpdate(item, force_update = false) {
		console.log("update_item_detail request", {
			code: item ? item.item_code : undefined,
			force_update,
		});
		if (!item || !item.item_code) {
			return;
		}

		if (item._manual_rate_set && !force_update) {
			return;
		}

		if (force_update) {
			item._detailSynced = false;
		}

		if (!force_update && item._detailSynced) {
			return;
		}

		const cacheKey = this._getItemDetailCacheKey(item);
		if (!force_update) {
			const cachedPayload = this._getCachedItemDetail(cacheKey);
			if (cachedPayload) {
				this._applyItemDetailPayload(item, cachedPayload, {
					forceUpdate: force_update,
					fromCache: true,
				});
				item._detailSynced = true;
				return;
			}
		}

		if (item._detailInFlight) {
			return;
		}

		item._detailInFlight = true;

		try {
			const currentDoc = this.get_invoice_doc();
			const response = await frappe.call({
				method: "posawesome.posawesome.api.items.get_item_detail",
				args: {
					warehouse: item.warehouse || this.pos_profile.warehouse,
					doc: currentDoc,
					price_list: this.selected_price_list || this.pos_profile.selling_price_list,
					company: this.pos_profile?.company,
					item: {
						item_code: item.item_code,
						customer: this.customer,
						doctype: currentDoc.doctype,
						name: currentDoc.name || `New ${currentDoc.doctype} 1`,
						company: this.pos_profile?.company,
						conversion_rate: 1,
						currency: this.pos_profile.currency,
						qty: item.qty,
						price_list_rate: item.base_price_list_rate ?? item.price_list_rate ?? 0,
						child_docname: `New ${currentDoc.doctype} Item 1`,
						cost_center: this.pos_profile.cost_center,
						pos_profile: this.pos_profile.name,
						uom: item.uom,
						tax_category: "",
						transaction_type: "selling",
						update_stock: this.pos_profile.update_stock,
						price_list: this.get_price_list(),
						has_batch_no: item.has_batch_no,
						has_serial_no: item.has_serial_no,
						serial_no: item.serial_no,
						batch_no: item.batch_no,
						is_stock_item: item.is_stock_item,
					},
				},
			});

			const data = response?.message;
			if (!data) {
				return;
			}

			this._applyItemDetailPayload(item, data, { forceUpdate: force_update, fromCache: false });
			this._storeItemDetailCache(cacheKey, data);
			item._detailSynced = true;
			if (typeof this.$forceUpdate === "function") {
				this.$forceUpdate();
			}
		} catch (error) {
			console.error("Error updating item detail:", error);
			this.eventBus.emit("show_message", {
				title: __("Error updating item details"),
				color: "error",
			});
		} finally {
			item._detailInFlight = false;
		}
	},

	_applyItemDetailPayload(item, data, options = {}) {
		const { forceUpdate = false } = options;

		if (!item.warehouse) {
			item.warehouse = this.pos_profile.warehouse;
		}
		if (data.price_list_currency) {
			this.price_list_currency = data.price_list_currency;
		}

		if (data.uom) {
			item.stock_uom = data.stock_uom;
			item.uom = data.uom;
		}
		if (data.conversion_factor) {
			item.conversion_factor = data.conversion_factor;
		}

		item.item_uoms = data.item_uoms || [];

		if (Array.isArray(item.item_uoms) && item.item_uoms.length) {
			const existingIndex = item.item_uoms.findIndex((uom) => uom.uom === item.uom);
			if (existingIndex === -1) {
				item.item_uoms.push({
					uom: item.uom,
					conversion_factor: item.conversion_factor || 1,
				});
			}
		}

		if (data.uom) {
			item.uom = data.uom;
		}

		item.allow_change_warehouse = data.allow_change_warehouse;
		item.locked_price = data.locked_price;
		item.description = data.description;
		item.item_tax_template = data.item_tax_template;
		item.discount_percentage = data.discount_percentage;
		item.warehouse = data.warehouse || item.warehouse;
		item.has_batch_no = data.has_batch_no;
		item.has_serial_no = data.has_serial_no;
		item.serial_no = data.serial_no;
		item.batch_no = data.batch_no;
		item.is_stock_item = data.is_stock_item;
		item.is_fixed_asset = data.is_fixed_asset;
		item.allow_alternative_item = data.allow_alternative_item;
                item.is_stock_item = data.is_stock_item;
                item.warehouse = data.warehouse || item.warehouse;

                item.actual_qty = data.actual_qty;
                item.available_qty = data.actual_qty;

                // Freeze stock BEFORE stock coordinator reduces it, if freeze setting is enabled
                if (this.freezeStockQuantity && this.fatehPosSettings?.freeze_stock_during_entry && item?.item_code) {
                        // Freeze the fresh stock from backend before stock coordinator modifies it
                        this.freezeStockQuantity(item);
                }

                const hasCode = item && item.item_code !== undefined && item.item_code !== null;
                const baseActualQty = Number(data.actual_qty);
                if (hasCode && Number.isFinite(baseActualQty)) {
                        item._base_actual_qty = baseActualQty;
                        item._base_available_qty = baseActualQty;
                        stockCoordinator.updateBaseQuantities(
                                [
                                        {
                                                item_code: item.item_code,
                                                actual_qty: baseActualQty,
                                        },
                                ],
                                { source: "invoice" },
                        );
                }

                if (hasCode) {
                        stockCoordinator.applyAvailabilityToItem(item, { updateBaseAvailable: false });
                        
                        // After stock coordinator reduces stock, restore frozen values if freeze is enabled
                        if (this.fatehPosSettings?.freeze_stock_during_entry && item?.item_code) {
                                const frozen = this.frozenStockQuantities?.get(item.item_code);
                                if (frozen) {
                                        if (frozen.actual_qty !== undefined && frozen.actual_qty !== null) {
                                                item.actual_qty = frozen.actual_qty;
                                        }
                                        if (frozen.max_qty !== undefined && frozen.max_qty !== null) {
                                                // max_qty will be set by update_qty_limits, so we need to restore after
                                        }
                                }
                        }
                }

                if (this.update_qty_limits) {
                        this.update_qty_limits(item);
                        
                        // Restore frozen max_qty after update_qty_limits sets it from reduced available_qty
                        if (this.fatehPosSettings?.freeze_stock_during_entry && item?.item_code) {
                                const frozen = this.frozenStockQuantities?.get(item.item_code);
                                if (frozen && frozen.max_qty !== undefined && frozen.max_qty !== null) {
                                        item.max_qty = frozen.max_qty;
                                }
                        }
                }

		if (data.barcode) {
			item.barcode = data.barcode;
		}
		if (data.brand) {
			item.brand = data.brand;
		}
		if (data.batch_no) {
			item.batch_no = data.batch_no;
		}
		if (data.serial_no_data) {
			item.serial_no_data = data.serial_no_data;
		}
		if (data.batch_no_data) {
			item.batch_no_data = data.batch_no_data;
		}
		if (
			item.has_batch_no &&
			this.pos_profile.posa_auto_set_batch &&
			!item.batch_no &&
			Array.isArray(data.batch_no_data) &&
			data.batch_no_data.length > 0
		) {
			item.batch_no_data = data.batch_no_data;
			this.set_batch_qty(item, null, false);
		}

		if (!item.locked_price) {
			if (forceUpdate || !item.base_rate) {
				if (data.price_list_rate !== 0 || !item.base_price_list_rate) {
					item.base_price_list_rate = data.price_list_rate;
					if (!item.posa_offer_applied) {
						item.base_rate = data.price_list_rate;
					}
				}
			}

			if (!item.posa_offer_applied) {
				const companyCurrency = this.pos_profile.currency;
				const baseCurrency = companyCurrency;

				if (
					this.selected_currency === this.price_list_currency &&
					this.selected_currency !== companyCurrency
				) {
					const conv = this.conversion_rate || 1;
					item.price_list_rate = this.flt(
						item.base_price_list_rate / conv,
						this.currency_precision,
					);

					if (!item._manual_rate_set) {
						item.rate = this.flt(item.base_rate / conv, this.currency_precision);
					}
				} else if (this.selected_currency !== baseCurrency) {
					const exchange_rate = this.exchange_rate || 1;
					item.price_list_rate = this.flt(
						item.base_price_list_rate * exchange_rate,
						this.currency_precision,
					);

					item.rate = this.flt(item.base_rate * exchange_rate, this.currency_precision);
				} else {
					item.price_list_rate = item.base_price_list_rate;

					if (!item._manual_rate_set) {
						item.rate = item.base_rate;
					}
				}
			} else {
				const baseCurrency = this.price_list_currency || this.pos_profile.currency;
				if (this.selected_currency !== baseCurrency) {
					item.price_list_rate = this.flt(
						item.base_rate * this.exchange_rate,
						this.currency_precision,
					);
				} else {
					item.price_list_rate = item.base_rate;
				}
			}

			if (
				!item.posa_offer_applied &&
				this.pos_profile.posa_apply_customer_discount &&
				this.customer_info.posa_discount > 0 &&
				this.customer_info.posa_discount <= 100 &&
				item.posa_is_offer == 0 &&
				!item.posa_is_replace
			) {
				const discount_percent =
					item.max_discount > 0
						? Math.min(item.max_discount, this.customer_info.posa_discount)
						: this.customer_info.posa_discount;

				item.discount_percentage = discount_percent;

				const discount_amount = this.flt(
					(item.price_list_rate * discount_percent) / 100,
					this.currency_precision,
				);
				item.discount_amount = discount_amount;

				item.base_discount_amount = this.flt(
					(item.base_price_list_rate * discount_percent) / 100,
					this.currency_precision,
				);

				item.rate = this.flt(item.price_list_rate - discount_amount, this.currency_precision);
				item.base_rate = this.flt(
					item.base_price_list_rate - item.base_discount_amount,
					this.currency_precision,
				);
			}
		}

                item.last_purchase_rate = data.last_purchase_rate;
                item.projected_qty = data.projected_qty;
                item.reserved_qty = data.reserved_qty;
                item.conversion_factor = data.conversion_factor;
                item.stock_qty = data.stock_qty;
                item.stock_uom = data.stock_uom;
                item.has_serial_no = data.has_serial_no;
                item.has_batch_no = data.has_batch_no;

		item.amount = this.flt(item.qty * item.rate, this.currency_precision);
		item.base_amount = this.flt(item.qty * item.base_rate, this.currency_precision);

		console.log(`Updated rates for ${item.item_code} on expand:`, {
			base_rate: item.base_rate,
			rate: item.rate,
			base_price_list_rate: item.base_price_list_rate,
			price_list_rate: item.price_list_rate,
			exchange_rate: this.exchange_rate,
			selected_currency: this.selected_currency,
			default_currency: this.pos_profile.currency,
		});
	},
	// Fetch customer details (info, price list, etc)
	async fetch_customer_details() {
		var vm = this;
		if (!this.customer) return;

                if (isOffline()) {
                        try {
                                const list = await getCustomerStorage();
                                const cached = (list || []).find(
                                        (c) => c.name === vm.customer || c.customer_name === vm.customer,
                                );
                                if (cached) {
                                        vm.customer_info = { ...cached };
                                        vm.sync_invoice_customer_details(vm.customer_info);
                                        // Auto-toggle credit sale for "Online Delivery" customer group
                                        if (cached.customer_group === "Online Delivery") {
                                                vm.eventBus.emit("auto_toggle_credit_sale", true);
                                        }
                                        if (vm.pos_profile.posa_force_price_from_customer_price_list !== false) {
                                                const defaultPriceList = vm.pos_profile?.selling_price_list || null;
                                                const resolvedPriceList = cached.customer_price_list || defaultPriceList;
                                                vm.selected_price_list = resolvedPriceList;
                                                vm.eventBus.emit("update_customer_price_list", resolvedPriceList);
                                                vm.apply_cached_price_list(resolvedPriceList);
                                        }
                                        return;
                                }
                                const queued = (getOfflineCustomers() || [])
                                        .map((e) => e.args)
                                        .find((c) => c.customer_name === vm.customer);
                                if (queued) {
                                        vm.customer_info = { ...queued, name: queued.customer_name };
                                        vm.sync_invoice_customer_details(vm.customer_info);
                                        // Auto-toggle credit sale for "Online Delivery" customer group
                                        if (queued.customer_group === "Online Delivery") {
                                                vm.eventBus.emit("auto_toggle_credit_sale", true);
                                        }
                                        if (vm.pos_profile.posa_force_price_from_customer_price_list !== false) {
                                                const defaultPriceList = vm.pos_profile?.selling_price_list || null;
                                                const resolvedPriceList = queued.customer_price_list || defaultPriceList;
                                                vm.selected_price_list = resolvedPriceList;
                                                vm.eventBus.emit("update_customer_price_list", resolvedPriceList);
                                                vm.apply_cached_price_list(resolvedPriceList);
                                        }
                                        return;
                                }
			} catch (error) {
				console.error("Failed to fetch cached customer", error);
			}
		}

		try {
			const r = await frappe.call({
				method: "posawesome.posawesome.api.customers.get_customer_info",
				args: {
					customer: vm.customer,
				},
			});
                        const message = r.message;
                        if (!r.exc) {
                                vm.customer_info = {
                                        ...message,
                                };
                                vm.sync_invoice_customer_details(vm.customer_info);
                                // Auto-toggle credit sale for "Online Delivery" customer group
                                if (message.customer_group === "Online Delivery") {
                                        vm.eventBus.emit("auto_toggle_credit_sale", true);
                                }
                        }
			// When force reload is enabled, automatically switch to the
			// customer's default price list so that item rates are fetched
			// correctly from the server.
                        if (vm.pos_profile.posa_force_price_from_customer_price_list !== false) {
                                const defaultPriceList = vm.pos_profile?.selling_price_list || null;
                                const resolvedPriceList = message.customer_price_list || defaultPriceList;
                                vm.selected_price_list = resolvedPriceList;
                                vm.eventBus.emit("update_customer_price_list", resolvedPriceList);
                                vm.apply_cached_price_list(resolvedPriceList);
                        }
                } catch (error) {
                        console.error("Failed to fetch customer details", error);
                }
        },

	// Get price list for current customer
	get_price_list() {
		// Use the currently selected price list if available,
		// otherwise fall back to the POS Profile selling price list
		return this.selected_price_list || this.pos_profile.selling_price_list;
	},

	// Update price list for customer
        update_price_list() {
                const price_list = this.pos_profile?.selling_price_list || null;
                const hasChanged = this.selected_price_list !== price_list;
                if (hasChanged) {
                        this.selected_price_list = price_list;
                } else if (this.selected_price_list === undefined) {
                        this.selected_price_list = price_list;
                }
                this.eventBus.emit("update_customer_price_list", price_list);
        },

        sync_invoice_customer_details(details = null) {
                if (!this.invoice_doc || typeof this.invoice_doc !== "object") {
                        return;
                }

                const existingDoc = this.invoice_doc || {};
                const customerDetails = details || this.customer_info || {};
                const resolvedCustomer = this.customer || customerDetails.customer || existingDoc.customer;
                const hasCustomerChanged =
                        existingDoc.customer && resolvedCustomer && existingDoc.customer !== resolvedCustomer;

                const resolvedCustomerName =
                        customerDetails.customer_name ??
                        customerDetails.customer ??
                        resolvedCustomer ??
                        null;

                const updatedDoc = {
                        ...existingDoc,
                        customer: resolvedCustomer,
                };

                const fieldsToSync = [
                        "customer_name",
                        "customer_group",
                        "customer_price_list",
                        "territory",
                        "customer_type",
                        "tax_id",
                        "primary_address",
                        "primary_address_name",
                        "customer_primary_address",
                        "shipping_address_name",
                        "customer_primary_contact",
                        "mobile_no",
                        "phone",
                        "email_id",
                        "contact_person",
                        "contact_display",
                        "contact_email",
                        "contact_mobile",
                        "contact_phone",
                ];

                fieldsToSync.forEach((field) => {
                        if (customerDetails[field] !== undefined && customerDetails[field] !== null) {
                                updatedDoc[field] = customerDetails[field];
                        }
                });

                const addressFields = {
                        customer_address:
                                customerDetails.customer_address ?? customerDetails.primary_address_name ?? null,
                        customer_address_display:
                                customerDetails.customer_address_display ?? customerDetails.primary_address ?? null,
                        shipping_address: customerDetails.shipping_address ?? null,
                        shipping_address_display:
                                customerDetails.shipping_address_display ?? customerDetails.shipping_address ?? null,
                };

                Object.entries(addressFields).forEach(([field, value]) => {
                        if (value !== undefined && value !== null) {
                                updatedDoc[field] = value;
                        } else if (hasCustomerChanged) {
                                updatedDoc[field] = null;
                        }
                });

                if (resolvedCustomerName) {
                        const previousTitle = existingDoc.title ?? null;
                        const titleMatchesPreviousCustomer =
                                previousTitle &&
                                (previousTitle === existingDoc.customer || previousTitle === existingDoc.customer_name);
                        if (hasCustomerChanged || !previousTitle || titleMatchesPreviousCustomer) {
                                updatedDoc.title = resolvedCustomerName;
                        }
                } else if (hasCustomerChanged) {
                        updatedDoc.title = resolvedCustomer || "";
                }

                if (hasCustomerChanged) {
                        const alwaysResetOnChange = [
                                "shipping_address_name",
                                "contact_person",
                                "contact_display",
                                "contact_email",
                                "contact_mobile",
                                "contact_phone",
                        ];

                        alwaysResetOnChange.forEach((field) => {
                                if (customerDetails[field] === undefined) {
                                        updatedDoc[field] = null;
                                }
                        });
                }

                this.invoice_doc = updatedDoc;
        },

	_applyPriceListRate(item, newRate, priceCurrency) {
		if (!item) {
			return;
		}

		const rate = Number.isFinite(Number(newRate)) ? Number(newRate) : 0;
		const resolvedCurrency = priceCurrency || this.selected_currency;
		const manualOverride = item._manual_rate_set === true;
		const companyCurrency = this.pos_profile?.currency;

		if (!item.original_currency) {
			item.original_currency = resolvedCurrency;
		}
		if (item.original_rate === undefined || item.original_rate === null) {
			item.original_rate = rate;
		}

		if (resolvedCurrency === this.selected_currency) {
			if (resolvedCurrency !== companyCurrency) {
				const conv = this.conversion_rate || 1;
				item.base_price_list_rate = rate * conv;
				if (!manualOverride) {
					item.base_rate = rate * conv;
				}
			} else {
				item.base_price_list_rate = rate;
				if (!manualOverride) {
					item.base_rate = rate;
				}
			}
			item.price_list_rate = rate;
			if (!manualOverride) {
				item.rate = rate;
			}
		} else {
			if (rate !== 0 || !item.base_price_list_rate) {
				item.base_price_list_rate = rate;
				if (!manualOverride) {
					item.base_rate = rate;
				}
			}

			if (this.selected_currency !== companyCurrency) {
				const conv = this.exchange_rate || 1;
				const converted = this.flt(rate * conv, this.currency_precision);
				if (rate !== 0 || !item.price_list_rate) {
					item.price_list_rate = converted;
				}
				if (!manualOverride && (rate !== 0 || !item.rate)) {
					item.rate = converted;
				}
			} else {
				if (rate !== 0 || !item.price_list_rate) {
					item.price_list_rate = rate;
				}
				if (!manualOverride && (rate !== 0 || !item.rate)) {
					item.rate = rate;
				}
			}
		}

		if (typeof item.qty === "number" && typeof item.rate === "number") {
			item.amount = this.flt(item.qty * item.rate, this.currency_precision);
		}
		if (typeof item.qty === "number" && typeof item.base_rate === "number") {
			item.base_amount = this.flt(item.qty * item.base_rate, this.currency_precision);
		}
	},

	// Apply cached price list rates to existing invoice items
	async apply_cached_price_list(price_list) {
		const targetPriceList = price_list || this.pos_profile?.selling_price_list;
		const cached = targetPriceList ? await getCachedPriceListItems(targetPriceList) : null;

		const fallbackItems = [];

		if (Array.isArray(this.items)) {
			if (Array.isArray(cached) && cached.length) {
				const priceMap = new Map();
				cached.forEach((row) => {
					if (row && row.item_code) {
						priceMap.set(row.item_code, row);
					}
				});

				this.items.forEach((item) => {
					if (!item || !item.item_code) {
						return;
					}
					const row = priceMap.get(item.item_code);
					if (row) {
						const rate = row.rate ?? row.price_list_rate ?? 0;
						const currency = row.currency || this.selected_currency;
						this._applyPriceListRate(item, rate, currency);
					} else {
						fallbackItems.push(item);
					}
				});
			} else {
				fallbackItems.push(...this.items);
			}
		}

		if (fallbackItems.length && !isOffline() && targetPriceList) {
			try {
				const response = await frappe.call({
					method: "posawesome.posawesome.api.items.get_items_details",
					args: {
						pos_profile: JSON.stringify(this.pos_profile),
						items_data: JSON.stringify(fallbackItems),
						price_list: targetPriceList,
					},
				});

				const details = response?.message;
				if (Array.isArray(details) && details.length) {
					const detailMap = new Map();
					details.forEach((detail) => {
						if (!detail) {
							return;
						}
						const key = detail.posa_row_id || detail.item_code;
						if (key) {
							detailMap.set(key, detail);
						}
					});

					fallbackItems.forEach((item) => {
						if (!item) {
							return;
						}
						const key = item.posa_row_id || item.item_code;
						const detail = detailMap.get(key);
						if (!detail) {
							return;
						}
						const rate = detail.price_list_rate ?? detail.rate ?? 0;
						const currency = detail.currency || detail.price_list_currency || this.selected_currency;
						this._applyPriceListRate(item, rate, currency);
					});
				}
			} catch (error) {
				console.error("Failed to refresh price list rates for invoice items", error);
			}
		}

		if (typeof this.$forceUpdate === "function") {
			this.$forceUpdate();
		}
	},
	// Update additional discount amount based on percentage
	update_discount_umount() {
		return updateDiscountAmount(this);
	},

	// Calculate prices and discounts for an item based on field change
	calc_prices(item, value, $event) {
		return calcPrices(item, value, $event, this);
	},

	// Calculate item price and discount fields
	calc_item_price(item) {
		return calcItemPrice(item, this);
	},

	// Fetch and set advances for a sales order
	fetch_and_set_advances(sales_order_name) {
		if (!sales_order_name || !this.invoice_doc) {
			return;
		}
		
		frappe.call({
			method: "posawesome.posawesome.api.minimal_sales_orders.get_advance_payments_for_sales_order",
			args: {
				sales_order_name: sales_order_name,
			},
			callback: (r) => {
				if (r.message && r.message.length > 0 && this.invoice_doc) {
					// Wait for next tick to ensure invoice_doc is fully updated
					this.$nextTick(() => {
						const invoice_total = flt(this.invoice_doc.grand_total || this.invoice_doc.rounded_total || 0);
						
						if (invoice_total > 0) {
							this.set_advances_and_adjust_payments(r.message, invoice_total, sales_order_name);
						}
					});
				}
			},
		});
	},

	set_advances_and_adjust_payments(advance_list, invoice_total, sales_order_name) {
		if (!this.invoice_doc || !advance_list || advance_list.length === 0) {
			return;
		}
		
		// Create new advances array for reactivity
		const new_advances = [];
		let total_allocated = 0;
		
		for (const advance of advance_list) {
			const remaining = invoice_total - total_allocated;
			if (remaining > 0) {
				const allocated_to_so = flt(advance.allocated_amount || advance.advance_amount);
				const allocated = Math.min(allocated_to_so, remaining);
				
				new_advances.push({
					reference_type: "Payment Entry",
					reference_name: advance.payment_entry,
					reference_row: "",
					remarks: advance.remarks || "",
					advance_amount: allocated_to_so,
					allocated_amount: allocated,
				});
				total_allocated += allocated;
			}
		}
		
		// Use Vue.set for reactivity
		if (this.$set) {
			this.$set(this.invoice_doc, 'advances', new_advances);
		} else {
			this.invoice_doc.advances = new_advances;
		}
		
		// Set sales_order on invoice_doc (use passed parameter, not this.sales_order_name)
		if (sales_order_name && this.invoice_doc) {
			if (this.$set) {
				this.$set(this.invoice_doc, 'sales_order', sales_order_name);
			} else {
				this.invoice_doc.sales_order = sales_order_name;
			}
		}
		
		// Update invoice store IMMEDIATELY to trigger reactive updates in computed properties
		// This must happen BEFORE $nextTick to ensure computed properties update immediately
		if (this.invoiceStore) {
			// Create new object with new array reference to trigger reactivity
			const updatedDoc = {
				...this.invoice_doc,
				advances: [...new_advances], // New array reference for reactivity
				sales_order: sales_order_name || this.invoice_doc.sales_order
			};
			
			// Update store - this should trigger computed properties to recalculate
			if (this.invoiceStore.setInvoiceDoc) {
				this.invoiceStore.setInvoiceDoc(updatedDoc);
			}
			
			// Also update local invoice_doc reference using Vue.set for reactivity
			if (this.$set) {
				this.$set(this.invoice_doc, 'advances', [...new_advances]);
				if (sales_order_name) {
					this.$set(this.invoice_doc, 'sales_order', sales_order_name);
				}
			} else {
				this.invoice_doc.advances = [...new_advances];
				if (sales_order_name) {
					this.invoice_doc.sales_order = sales_order_name;
				}
			}
		}
		
		// Force immediate update to trigger computed properties BEFORE $nextTick
		this.$forceUpdate();
		
		// Adjust payments to match outstanding amount
		this.$nextTick(() => {
			this.adjust_payments_for_advance(total_allocated);
			// Force update again after payment adjustment
			this.$forceUpdate();
			// Emit event to refresh payment panel and summary
			if (this.eventBus) {
				this.eventBus.emit('invoice_doc_updated');
				this.eventBus.emit('advances_updated');
			}
		});
	},

	// Adjust payment amounts to match outstanding after advance deduction
	adjust_payments_for_advance(total_advance) {
		if (!this.invoice_doc || total_advance <= 0) {
			return;
		}
		
		// Calculate outstanding amount (grand_total - advance)
		const invoice_total = flt(this.invoice_doc.grand_total || this.invoice_doc.rounded_total || 0);
		const outstanding = flt(invoice_total - total_advance);
		
		// Set payment as a SUGGESTION (user can still edit to enter actual cash tendered)
		if (this.invoice_doc.payments && this.invoice_doc.payments.length > 0) {
			// Set suggested amount = outstanding (minimum to pay)
			// User can increase this if customer pays more (e.g., 100 when outstanding is 50)
			this.invoice_doc.payments[0].amount = outstanding;
			if (this.invoice_doc.payments[0].base_amount !== undefined) {
				this.invoice_doc.payments[0].base_amount = outstanding;
			}
		}
		
		// Update store
		if (this.invoiceStore && this.invoiceStore.setInvoiceDoc) {
			this.invoiceStore.setInvoiceDoc({...this.invoice_doc});
		}
		this.$forceUpdate();
	},

	// Update UOM (unit of measure) for an item and recalculate prices
	calc_uom(item, value) {
		if (!item) {
			return;
		}
		return this.queueItemTask(item, "calc_uom", () => calcUom(item, value, this));
	},

	// Calculate stock quantity for an item (simplified - validation handled centrally)
	calc_stock_qty(item, value) {
		calcStockQty(item, value, this);
		if (this.update_qty_limits) {
			this.update_qty_limits(item);
		}

		if (flt(item.qty) === 0) {
			this.remove_item(item);
			this.$forceUpdate();
		}
	},

	// Update quantity limits based on available stock (simplified - validation handled centrally)
        update_qty_limits(item) {
                if (item && item.is_stock_item === 0) {
                        item.max_qty = undefined;
                        item.disable_increment = false;
                        return;
                }

                if (item && item.available_qty !== undefined) {
                        item.max_qty = flt(item.available_qty / (item.conversion_factor || 1));

                        // Set increment disable flag based on stock limits
                        const allowNegative = this.stock_settings?.allow_negative_stock ?? false;
                        item.disable_increment =
                                (!allowNegative || this.blockSaleBeyondAvailableQty) &&
                                item.qty >= item.max_qty;
                }
        },

        // Fetch available stock for an item and cache it
        async fetch_available_qty(item) {
                if (!item || !item.item_code || !item.warehouse || item.is_stock_item === 0) return;

		const key = this._getStockCacheKey(item);
		const cachedQty = this._getCachedStockQty(key);
		if (cachedQty !== null && cachedQty !== undefined) {
			item.available_qty = cachedQty;
			this.update_qty_limits(item);
			return cachedQty;
		}

		const runner = async () => {
			try {
				const response = await frappe.call({
					method: "posawesome.posawesome.api.items.get_available_qty",
					args: {
						items: JSON.stringify([
							{
								item_code: item.item_code,
								warehouse: item.warehouse,
								batch_no: item.batch_no,
							},
						]),
					},
				});
				const qty =
					response.message && response.message.length ? flt(response.message[0].available_qty) : 0;
				this._storeStockQty(key, qty);
				if (this.available_stock_cache) {
					this.available_stock_cache[key] = { qty, ts: Date.now() };
				}
				item.available_qty = qty;
				this.update_qty_limits(item);
				return qty;
			} catch (error) {
				console.error("Failed to fetch available qty", error);
				throw error;
			}
		};

		return this.queueItemTask(item, "fetch_available_qty", runner);
	},

	// Set serial numbers for an item (and update qty)
	set_serial_no(item) {
		return setSerialNo(item, this);
	},

	// Set batch number for an item (and update batch data)
	set_batch_qty(item, value, update = true) {
		return setBatchQty(item, value, update, this);
	},

	change_price_list_rate(item) {
		const vm = this;

		const d = new frappe.ui.Dialog({
			title: __("Change Price"),
			fields: [
				{
					fieldname: "new_rate",
					fieldtype: "Float",
					label: __("New Price List Rate"),
					default: item.price_list_rate ?? item.rate ?? 0,
					reqd: 1,
				},
			],
			primary_action_label: __("Update"),
			primary_action(values) {
				const rate = flt(values.new_rate);
				frappe.call({
					method: "posawesome.posawesome.api.items.update_price_list_rate",
					args: {
						item_code: item.item_code,
						price_list: vm.get_price_list(),
						rate: rate,
						uom: item.uom,
					},
					callback(r) {
						if (!r.exc) {
							item.price_list_rate = rate;
							item.base_price_list_rate = rate;
							if (!item._manual_rate_set) {
								item.rate = rate;
								item.base_rate = rate;
							}
							vm.calc_item_price(item);
							vm.eventBus.emit("show_message", {
								title: r.message || __("Item price updated"),
								color: "success",
							});
						}
					},
				});
				d.hide();
			},
		});

		d.get_field("new_rate").$input.on("keydown", function (e) {
			if (e.key === "Enter") {
				d.get_primary_btn().click();
			}
		});

		d.show();
	},
};
