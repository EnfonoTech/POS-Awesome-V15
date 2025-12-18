<template>
	<!-- Main Invoice Wrapper -->
	<div class="pa-0">
		<!-- Cancel Sale Confirmation Dialog -->
		<CancelSaleDialog v-model="cancel_dialog" @confirm="cancel_invoice" />

		<!-- Scan Error Dialog - VERSION 2.0.3: Removed, ItemsSelector handles error notifications -->

		<!-- Main Invoice Card (contains all invoice content) -->
		<v-card
			ref="invoiceCard"
			:style="{
				height: invoiceHeight || 'var(--container-height)',
				maxHeight: invoiceHeight || 'var(--container-height)',
				resize: 'vertical',
				overflow: 'auto',
			}"
			:class="['cards my-0 py-0 mt-3 resizable', 'pos-themed-card', { 'return-mode': isReturnInvoice }]"
			@mouseup="saveInvoiceHeight"
			@touchend="saveInvoiceHeight"
		>
			<!-- Dynamic padding wrapper -->
			<div class="dynamic-padding">
				<v-alert
					type="info"
					density="compact"
					class="mb-2"
					v-if="pos_profile.create_pos_invoice_instead_of_sales_invoice"
				>
					{{ __("Invoices saved as POS Invoices") }}
				</v-alert>
				<!-- Top Row: Customer Selection and Invoice Type -->
				<v-row align="center" class="items px-3 py-2">
					<v-col :cols="pos_profile.posa_allow_sales_order ? 9 : 12" class="pb-0 pr-0">
						<div class="d-flex align-start gap-2">
							<!-- Customer selection component -->
							<div class="flex-grow-1">
								<Customer ref="customerComponent" />
							</div>
							<!-- Quick Customer Buttons -->
							<div v-if="quickCustomers.length > 0" class="d-flex align-start gap-1 flex-shrink-0">
								<v-btn
									v-for="(quickCustomer, index) in quickCustomers"
									:key="index"
									size="small"
									variant="tonal"
									color="primary"
									density="compact"
									class="quick-customer-btn"
									@click="selectQuickCustomer(quickCustomer.customer)"
								>
									{{ quickCustomer.button_label || quickCustomer.customer_name }}
								</v-btn>
							</div>
						</div>
					</v-col>
					<!-- Invoice Type Selection (Only shown if sales orders are allowed) -->
					<v-col v-if="pos_profile.posa_allow_sales_order" cols="3" class="pb-4">
						<v-select
							density="compact"
							hide-details
							variant="solo"
							color="primary"
							class="sleek-field pos-themed-input"
							:items="invoiceTypes"
							:label="frappe._('Type')"
							v-model="invoiceType"
							:disabled="invoiceType == 'Return'"
						></v-select>
					</v-col>
				</v-row>


				<!-- Delivery Charges Section (Only if enabled in POS profile) -->
				<DeliveryCharges
					:pos_profile="pos_profile"
					:delivery_charges="delivery_charges"
					:selected_delivery_charge="selected_delivery_charge"
					:delivery_charges_rate="delivery_charges_rate"
					:deliveryChargesFilter="deliveryChargesFilter"
					:formatCurrency="formatCurrency"
					:currencySymbol="currencySymbol"
					:readonly="readonly"
					@update:selected_delivery_charge="
						(val) => {
							selected_delivery_charge = val;
							update_delivery_charges();
						}
					"
				/>

				<!-- Posting Date and Customer Balance Section -->
				<PostingDateRow
					:pos_profile="pos_profile"
					:posting_date_display="posting_date_display"
					:customer_balance="customer_balance"
					:price-list="selected_price_list"
					:price-lists="price_lists"
					:formatCurrency="formatCurrency"
					@update:posting_date_display="
						(val) => {
							posting_date_display = val;
						}
					"
					@update:priceList="
						(val) => {
							selected_price_list = val;
						}
					"
				/>

				<!-- Multi-Currency Section (Only if enabled in POS profile) -->
				<MultiCurrencyRow
					:pos_profile="pos_profile"
					:selected_currency="selected_currency"
					:plc_conversion_rate="exchange_rate"
					:conversion_rate="conversion_rate"
					:available_currencies="available_currencies"
					:isNumber="isNumber"
					:price_list_currency="price_list_currency"
					@update:selected_currency="
						(val) => {
							selected_currency = val;
							update_currency(val);
						}
					"
					@update:plc_conversion_rate="
						(val) => {
							exchange_rate = val;
							update_exchange_rate();
						}
					"
					@update:conversion_rate="
						(val) => {
							conversion_rate = val;
							update_conversion_rate();
						}
					"
				/>

				<!-- Items Table Section (Main items list for invoice) -->
				<div class="items-table-wrapper">
					<!-- Column selector button moved outside the table -->
					<div class="column-selector-container">
						<div class="search-fields-container">
							<!-- VERSION 2.0.2 - Scanner input replaces search field -->
							<v-text-field
								ref="manualScanInput"
								v-model="manualScanValue"
								density="compact"
								variant="solo"
								color="primary"
								class="item-search-field pos-themed-input"
								:label="__('Search barcode')"
								prepend-inner-icon="mdi-barcode-scan"
								hide-details
								clearable
								autocomplete="off"
								@keydown.enter.prevent="submitManualScan"
								@click:clear="manualScanValue = ''"
							>
								<template #append-inner>
									<v-btn
										icon="mdi-check"
										variant="tonal"
										color="primary"
										size="small"
										@click="submitManualScan"
										:title="__('Submit Code')"
									></v-btn>
								</template>
							</v-text-field>
							<v-autocomplete
								v-if="enableQuickItemSearch"
								ref="quickItemSearchInput"
								class="item-search-field pos-themed-input"
								v-model="quickItemSelection"
								:items="quickItemOptions"
								item-title="title"
								item-value="value"
								v-model:search="quickItemSearch"
								:label="__('Item Search')"
								:placeholder="__('Item code')"
								:no-data-text="__('No items found')"
								density="compact"
								variant="solo"
								color="primary"
								clearable
								hide-details
								return-object
								:filter="() => true"
								@update:search="onQuickItemSearch"
								@update:model-value="onQuickItemSelected"
								@keydown.enter.prevent="onQuickItemEnter"
								@focus="onQuickItemFocus"
							>
							<template #item="{ props, item }">
								<v-list-item v-bind="props">
									<v-list-item-title>{{ item.raw.item_name || item.raw.item_code }}</v-list-item-title>
								</v-list-item>
							</template>
							<template #selection="{ item }">
								{{ item.raw.item_name || item.raw.item_code }}
							</template>
							</v-autocomplete>
						</div>
						<v-btn
							density="compact"
							variant="text"
							color="primary"
							prepend-icon="mdi-cog-outline"
							@click="toggleColumnSelection"
							class="column-selector-btn"
						>
							{{ __("Columns") }}
						</v-btn>

						<v-dialog v-model="show_column_selector" max-width="500px">
							<v-card>
								<v-card-title class="text-h6 pa-4 d-flex align-center">
									<span>{{ __("Select Columns to Display") }}</span>
									<v-spacer></v-spacer>
									<v-btn
										icon="mdi-close"
										variant="text"
										density="compact"
										@click="show_column_selector = false"
									></v-btn>
								</v-card-title>
								<v-divider></v-divider>
								<v-card-text class="pa-4">
									<v-row dense>
										<v-col
											cols="12"
											v-for="column in available_columns.filter((col) => !col.required)"
											:key="column.key"
										>
											<v-switch
												v-model="temp_selected_columns"
												:label="column.title"
												:value="column.key"
												hide-details
												density="compact"
												color="primary"
												class="column-switch mb-1"
												:disabled="column.required"
											></v-switch>
										</v-col>
									</v-row>
									<div class="text-caption mt-2">
										{{ __("Required columns cannot be hidden") }}
									</div>
								</v-card-text>
								<v-card-actions class="pa-4 pt-0">
									<v-btn color="error" variant="text" @click="cancelColumnSelection">{{
										__("Cancel")
									}}</v-btn>
									<v-spacer></v-spacer>
									<v-btn color="primary" variant="tonal" @click="updateSelectedColumns">{{
										__("Apply")
									}}</v-btn>
								</v-card-actions>
							</v-card>
						</v-dialog>
					</div>

					<!-- ItemsTable component with reorder event handler -->
					<ItemsTable
						ref="itemsTable"
						:headers="items_headers"
						v-model:expanded="expanded"
						:itemsPerPage="itemsPerPage"
						:itemSearch="itemSearch"
						:pos_profile="pos_profile"
						:invoiceType="invoiceType"
						:stock_settings="stock_settings"
						:displayCurrency="displayCurrency"
						:formatFloat="formatFloat"
						:formatCurrency="formatCurrency"
						:currencySymbol="currencySymbol"
						:isNumber="isNumber"
						:setFormatedQty="setFormatedQty"
						:setFormatedCurrency="setFormatedCurrency"
						:calcPrices="calc_prices"
						:calcUom="calc_uom"
						:setSerialNo="set_serial_no"
						:setBatchQty="set_batch_qty"
						:validateDueDate="validate_due_date"
						:removeItem="remove_item"
						:subtractOne="subtract_one"
						:addOne="add_one"
						:toggleOffer="toggleOffer"
						:changePriceListRate="change_price_list_rate"
						:isNegative="isNegative"
						@update:expanded="handleExpandedUpdate"
						@reorder-items="handleItemReorder"
						@add-item-from-drag="handleItemDrop"
						@show-drop-feedback="showDropFeedback"
						@item-dropped="showDropFeedback(false)"
						@view-packed="openPackedItems"
					/>
					<v-dialog v-model="show_packed_dialog" max-width="800px">
						<v-card>
							<v-card-title class="d-flex align-center">
								<span>{{ __("Packing List") }} ({{ packed_dialog_items.length }})</span>
								<v-spacer></v-spacer>
								<v-btn
									icon="mdi-close"
									variant="text"
									density="compact"
									@click="show_packed_dialog = false"
								></v-btn>
							</v-card-title>
							<v-divider></v-divider>
							<v-card-text>
								<v-alert type="warning" density="compact" class="mb-2">
									{{
										__(
											"For 'Product Bundle' items, Warehouse, Serial No and Batch No will be considered from the 'Packing List' table. If Warehouse and Batch No are same for all packing items for any 'Product Bundle' item, those values can be entered in the main Item table; values will be copied to 'Packing List' table.",
										)
									}}
								</v-alert>
								<v-data-table
									:headers="packedItemsHeaders"
									:items="packed_dialog_items"
									class="elevation-1"
									hide-default-footer
									density="compact"
								>
									<template v-slot:item.index="{ index }">
										{{ index + 1 }}
									</template>
									<template v-slot:item.qty="{ item }">
										{{ formatFloat(item.qty) }}
									</template>
									<template v-slot:item.rate="{ item }">
										<div class="currency-display">
											<span class="currency-symbol">{{
												currencySymbol(displayCurrency)
											}}</span>
											<span class="amount-value">{{ formatCurrency(item.rate) }}</span>
										</div>
									</template>
									<template v-slot:item.warehouse="{ item }">
										<v-text-field
											v-model="item.warehouse"
											hide-details
											density="compact"
										/>
									</template>
									<template v-slot:item.batch_no="{ item }">
										<v-text-field
											v-model="item.batch_no"
											hide-details
											density="compact"
										/>
									</template>
									<template v-slot:item.serial_no="{ item }">
										<v-text-field
											v-model="item.serial_no"
											hide-details
											density="compact"
										/>
									</template>
								</v-data-table>
							</v-card-text>
						</v-card>
					</v-dialog>
				</div>
			</div>
		</v-card>
		<!-- Payment Section -->
		<InvoiceSummary
			:pos_profile="pos_profile"
			:total_qty="total_qty"
			:additional_discount="additional_discount"
			:additional_discount_percentage="additional_discount_percentage"
			:total_items_discount_amount="total_items_discount_amount"
			:subtotal="subtotal"
			:displayCurrency="displayCurrency"
			:formatFloat="formatFloat"
			:formatCurrency="formatCurrency"
			:currencySymbol="currencySymbol"
			:discount_percentage_offer_name="discount_percentage_offer_name"
			:isNumber="isNumber"
			@update:additional_discount="(val) => (additional_discount = val)"
			@update:additional_discount_percentage="(val) => (additional_discount_percentage = val)"
			@update_discount_umount="update_discount_umount"
			@save-and-clear="handleSaveAndClear"
			@load-drafts="get_draft_invoices"
			@select-order="get_draft_orders"
			@cancel-sale="cancel_dialog = true"
			@open-returns="open_returns"
			@print-draft="print_draft_invoice"
			@apply-offers="apply_offers_and_reload"
			@show-payment="show_payment"
		/>
	</div>
</template>

<script>
/* global frappe, __ */
import format from "../../format";
import Customer from "./Customer.vue";
import DeliveryCharges from "./DeliveryCharges.vue";
import PostingDateRow from "./PostingDateRow.vue";
import MultiCurrencyRow from "./MultiCurrencyRow.vue";
import CancelSaleDialog from "./CancelSaleDialog.vue";
import InvoiceSummary from "./InvoiceSummary.vue";
import ItemsTable from "./ItemsTable.vue";
import invoiceItemMethods from "./invoiceItemMethods";
import invoiceComputed from "./invoiceComputed";
import invoiceWatchers from "./invoiceWatchers";
import offerMethods from "./invoiceOfferMethods";
import shortcutMethods from "./invoiceShortcuts";
import { useInvoiceStore } from "../../stores/invoiceStore.js";
import { useCustomersStore } from "../../stores/customersStore.js";
import { storeToRefs } from "pinia";
import stockCoordinator from "../../utils/stockCoordinator.js";

export default {
	name: "POSInvoice",
	mixins: [format],
	setup() {
		const invoiceStore = useInvoiceStore();
		const customersStore = useCustomersStore();
		const { selectedCustomer, refreshToken } = storeToRefs(customersStore);
		return { invoiceStore, customersStore, selectedCustomer, customerRefreshToken: refreshToken };
	},
	data() {
		return {
			// POS profile settings
			pos_profile: "",
			pos_opening_shift: "",
			stock_settings: "",
			return_doc: "",
			customer: "",
			customer_info: "",
			customer_balance: 0,
			discount_amount: 0,
			additional_discount: 0,
			additional_discount_percentage: 0,
			total_tax: 0,
			packed_dialog_items: [], // Packed items displayed in dialog
			show_packed_dialog: false, // Packing list dialog visibility
			posOffers: [], // All available offers
			posa_offers: [], // Offers applied to this invoice
			posa_coupons: [], // Coupons applied
			isApplyingOffer: false, // Flag to prevent offer watcher loops
			allItems: [], // All items for offer logic
			discount_percentage_offer_name: null, // Track which offer is applied
			invoiceTypes: ["Invoice", "Order", "Quotation"], // Types of invoices
			invoiceType: "Invoice", // Current invoice type
			itemsPerPage: 1000, // Items per page in table
			itemSearch: "", // Search query for added items
			expanded: [], // Array of expanded row IDs
			singleExpand: true, // Only one row expanded at a time
			cancel_dialog: false, // Cancel dialog visibility
			float_precision: 6, // Float precision for calculations
			currency_precision: 6, // Currency precision for display
			new_line: false, // Add new line for item
                        available_stock_cache: {},
                        item_detail_cache: {},
                        item_stock_cache: {},
                        brand_cache: {},
                        stockUnsubscribe: null,
			delivery_charges: [], // List of delivery charges
			base_delivery_charges_rate: 0, // Delivery charge in company currency
			delivery_charges_rate: 0, // Selected delivery charge rate
			selected_delivery_charge: "", // Selected delivery charge object
			invoice_posting_date: false, // Posting date dialog
			posting_date: frappe.datetime.nowdate(), // Invoice posting date
			posting_date_display: "", // Display value for date picker
			items_headers: [],
			manualScanValue: "", // Manual scanner input value
			enableQuickItemSearch: false, // Toggle for quick item search above selected items
			quickItemSelection: null,
			quickItemSearch: "",
			quickItemOptions: [],
			quickCustomers: [], // Quick customer buttons from Fateh POS Settings
			// Scanner-related properties (matching ItemsSelector)
			scanErrorDialog: false,
			scanErrorMessage: "",
			scanErrorDetails: "",
			scanErrorCode: "",
			scannerLocked: false,
			pendingScanCode: "",
			awaitingScanResult: false,
			scanDebounceId: null,
			scanQueuedCode: "",
			search_from_scanner: false,
			packedItemsHeaders: [
				{ title: __("No."), key: "index" },
				{ title: __("Parent Item"), key: "parent_item" },
				{ title: __("Item Code"), key: "item_code" },
				{ title: __("Description"), key: "item_name" },
				{ title: __("Qty"), key: "qty" },
				{ title: __("Rate"), key: "rate" },
				{ title: __("Warehouse"), key: "warehouse" },
				{ title: __("Batch"), key: "batch_no" },
				{ title: __("Serial"), key: "serial_no" },
			],
			selected_currency: "", // Currently selected currency
			exchange_rate: 1, // Current exchange rate
			conversion_rate: 1, // Currency to company rate
			exchange_rate_date: frappe.datetime.nowdate(), // Date of fetched exchange rate
			company: null, // Company doc with default currency
			available_currencies: [], // List of available currencies
			price_lists: [], // Available selling price lists
			selected_price_list: "", // Currently selected price list
			price_list_currency: "", // Currency of the selected price list
			_shortcutHandlers: {},
			selected_columns: [], // Selected columns for items table
                        temp_selected_columns: [], // Temporary array for column selection
                        available_columns: [], // All available columns
                        show_column_selector: false, // Column selector dialog visibility
                        invoiceHeight: null,
                        paymentVisible: false, // Track current payment view state
                        _busHandlers: {},
                        scanAudioContext: null, // Audio context for scan tones
                };
        },

	components: {
		Customer,
		DeliveryCharges,
		PostingDateRow,
		MultiCurrencyRow,
		InvoiceSummary,
		CancelSaleDialog,
		ItemsTable,
	},
	computed: {
		items: {
			get() {
				return this.invoiceStore.items;
			},
			set(value) {
				this.invoiceStore.setItems(value);
			},
		},
		invoice_doc: {
			get() {
				return this.invoiceStore.invoiceDoc;
			},
			set(value) {
				this.invoiceStore.setInvoiceDoc(value);
			},
		},
		packed_items: {
			get() {
				return this.invoiceStore.packedItems;
			},
			set(value) {
				this.invoiceStore.setPackedItems(value);
			},
		},
                ...invoiceComputed,
        },

        methods: {
                ...shortcutMethods,
		...offerMethods,
		...invoiceItemMethods,
                focusCustomerSearchField() {
                        const customerComponent = this.$refs.customerComponent;
                        if (!customerComponent) {
                                return;
                        }

                        const focusFn = customerComponent.focusCustomerSearch;
                        if (typeof focusFn === "function") {
                                focusFn();
                        }
                },

                focusItemSearchField() {
                        this.eventBus.emit("focus_item_search");
                },

                submitManualScan() {
                        // VERSION 2.0.3 - Scanner submission (ItemsSelector handles locking)
                        const code = (this.manualScanValue ?? "").toString().trim();
                        if (!code) {
                                return;
                        }
                        // Removed scanner lock check - ItemsSelector handles all scanner locking logic
                        this.manualScanValue = "";
                        this.onBarcodeScanned(code);
                        this.queueManualScanFocus();
                },

                onBarcodeScanned(scannedCode) {
                        // VERSION 2.0.3 - Scanner validation (ItemsSelector handles locking/unlocking)
                        // Removed scanner lock check - ItemsSelector handles all scanner locking logic

                        const runScanPipeline = async (code) => {
                                try {
                                        this.pendingScanCode = code;

                                        // mark this search as coming from a scanner
                                        this.search_from_scanner = true;

                                        // VERSION 2.0.4 - Removed scanning feedback (ItemsSelector already shows it)
                                        // Don't show scanning message - ItemsSelector handles it to avoid duplicate "(2)" notifications

                                        // Emit to ItemsSelector to handle the scanning with all validations
                                        this.eventBus.emit("scan_barcode", code);
                                } catch (error) {
                                        this.handleScanPipelineError(error, code);
                                }
                        };

                        if (this.scanDebounceId) {
                                clearTimeout(this.scanDebounceId);
                        }
                        this.scanQueuedCode = scannedCode;
                        this.scanDebounceId = setTimeout(() => {
                                this.scanDebounceId = null;
                                const code = this.scanQueuedCode || scannedCode;
                                this.scanQueuedCode = "";
                                this.$nextTick(() => {
                                        const maybePromise = runScanPipeline(code);
                                        if (maybePromise && typeof maybePromise.catch === "function") {
                                                maybePromise.catch((error) => {
                                                        this.handleScanPipelineError(error, code);
                                                });
                                        }
                                });
                        }, 12);
                },

                handleScanPipelineError(error, code = "") {
                        const normalizedCode = code || this.pendingScanCode || "";
                        const details =
                                error && typeof error.message === "string" && error.message.trim()
                                        ? error.message
                                        : this.__("Please try again or enter the item manually.");
                        this.showScanError({
                                message: this.__("Unable to add scanned item."),
                                code: normalizedCode,
                                details,
                        });
                },

                showScanError({ message, code = "", details = "" } = {}) {
                        // VERSION 2.0.3 - Error handling (ItemsSelector already shows notifications and handles locking)
                        // Don't show error dialog or lock scanner - ItemsSelector handles it
                        this.scanErrorMessage = message || this.__("Unable to add scanned item.");
                        this.scanErrorCode = code;
                        this.scanErrorDetails = details;
                        if (code) {
                                this.pendingScanCode = code;
                        }
                        this.awaitingScanResult = false;
                        this.search_from_scanner = false;
                        // Don't show dialog or lock scanner - ItemsSelector handles error notifications and locking
                        // this.scanErrorDialog = true;
                        // this.scannerLocked = true;
                        // Don't play tone - ItemsSelector already plays error tone
                        // this.playScanTone("error");
                },

                acknowledgeScanError() {
                        this.scanErrorDialog = false;
                        this.scannerLocked = false;
                        this.scanErrorMessage = "";
                        this.scanErrorCode = "";
                        this.scanErrorDetails = "";
                        this.pendingScanCode = "";
                        this.awaitingScanResult = false;
                        this.queueManualScanFocus();
                },

                focusManualScanInput() {
                        const input = this.$refs.manualScanInput;
                        if (input && typeof input.focus === "function") {
                                input.focus();
                        }
                },

                queueManualScanFocus() {
                        this.$nextTick(() => {
                                const scheduler =
                                        typeof requestAnimationFrame === "function"
                                                ? requestAnimationFrame
                                                : (cb) => setTimeout(cb, 16);
                                scheduler(() => {
                                        this.focusManualScanInput();
                                });
                        });
                },

                ensureScanAudioContext() {
                        if (typeof window === "undefined") {
                                return null;
                        }
                        if (!this.scanAudioContext) {
                                const AudioContext = window.AudioContext || window.webkitAudioContext;
                                if (!AudioContext) {
                                        return null;
                                }
                                this.scanAudioContext = new AudioContext();
                        }
                        if (this.scanAudioContext?.state === "suspended") {
                                this.scanAudioContext.resume().catch(() => {});
                        }
                        return this.scanAudioContext;
                },

                playScanTone(type = "success") {
                        if (typeof window === "undefined") {
                                return;
                        }
                        try {
                                const ctx = this.ensureScanAudioContext();
                                if (!ctx) {
                                        if (frappe?.utils?.play_sound) {
                                                frappe.utils.play_sound(type === "success" ? "submit" : "error");
                                        }
                                        return;
                                }
                                const now = ctx.currentTime;
                                const duration = type === "success" ? 0.16 : 0.35;
                                const oscillator = ctx.createOscillator();
                                const gainNode = ctx.createGain();
                                oscillator.type = "sine";
                                oscillator.frequency.value = type === "success" ? 880 : 220;
                                gainNode.gain.setValueAtTime(type === "success" ? 0.18 : 0.28, now);
                                gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);
                                oscillator.connect(gainNode);
                                gainNode.connect(ctx.destination);
                                oscillator.start(now);
                                oscillator.stop(now + duration);
                        } catch (error) {
                                console.warn("Scan tone playback failed:", error);
                                if (frappe?.utils?.play_sound) {
                                        frappe.utils.play_sound(type === "success" ? "submit" : "error");
                                }
                        }
                },

                handleScanErrorFromItemsSelector(data) {
                        // VERSION 2.0.3 - ItemsSelector already shows error notification and handles locking
                        // Don't lock Invoice scanner - ItemsSelector handles scanner lock/unlock
                        if (data && typeof data === "object") {
                                // Don't show error dialog - ItemsSelector already shows frappe.show_alert
                                // Don't lock scanner - ItemsSelector handles it
                                // Just update internal state
                                this.awaitingScanResult = false;
                                this.search_from_scanner = false;
                                // Store error details but don't show dialog or lock scanner
                                this.scanErrorMessage = data.message || this.__("Unable to add scanned item.");
                                this.scanErrorCode = data.code || "";
                                this.scanErrorDetails = data.details || "";
                        }
                },

                handleScanSuccess(data) {
                        // VERSION 2.0.3 - Success handling (ItemsSelector already shows success notification)
                        this.scannerLocked = false;
                        this.search_from_scanner = false;
                        this.pendingScanCode = "";
                        this.awaitingScanResult = false;
                        // Removed playScanTone - ItemsSelector already plays success tone
                        this.queueManualScanFocus();
                },
                // VERSION 2.0.3 - Handle scan error acknowledgment from ItemsSelector
                handleScanErrorAcknowledged() {
                        this.scannerLocked = false;
                        this.awaitingScanResult = false;
                        this.search_from_scanner = false;
                        this.scanErrorMessage = "";
                        this.scanErrorCode = "";
                        this.scanErrorDetails = "";
                        this.pendingScanCode = "";
                        this.queueManualScanFocus();
                },

                initializeItemsHeaders() {
                        // Define all available columns
                        this.available_columns = [
                                { title: __("Name"), align: "start", sortable: true, key: "item_name", required: true },
				{ title: __("QTY"), key: "qty", align: "center", required: true },
				{ title: __("UOM"), key: "uom", align: "center", required: false },
				{
					title: __("Price List Rate"),
					key: "price_list_rate",
					align: "end",
					required: false,
					width: "120px",
				},
				{ title: __("Discount %"), key: "discount_value", align: "end", required: false },
				{ title: __("Discount Amount"), key: "discount_amount", align: "end", required: false },
				{ title: __("Rate"), key: "rate", align: "center", required: true },
				{ title: __("Amount"), key: "amount", align: "center", required: true },
				{ title: __("Offer?"), key: "posa_is_offer", align: "center", required: false },
				{ title: __("Actions"), key: "actions", align: "center", required: true, sortable: false },
			];

			// Initialize selected columns if empty
			if (!this.selected_columns || this.selected_columns.length === 0) {
				// By default, select all required columns and those enabled in POS profile
				this.selected_columns = this.available_columns
					.filter((col) => {
						if (col.required) return true;
						if (col.key === "uom") return true; // Always show UOM column for inline editing
						if (col.key === "price_list_rate") return true;
						if (col.key === "discount_value" && this.pos_profile.posa_display_discount_percentage)
							return true;
						if (col.key === "discount_amount" && this.pos_profile.posa_display_discount_amount)
							return true;
						return false;
					})
					.map((col) => col.key);
			}

                        // Generate headers based on selected columns
                        this.updateHeadersFromSelection();
                },
                emitCartQuantities() {
                        const totals = {};
                        const normalizeNumber = (value) => {
                                const num = Number(value);
                                return Number.isFinite(num) ? num : null;
                        };
                        const accumulate = (line) => {
                                if (!line || !line.item_code) {
                                        return;
                                }

                                const code = String(line.item_code).trim();
                                if (!code) {
                                        return;
                                }

                                let stockQty = normalizeNumber(line.stock_qty);
                                if (stockQty === null) {
                                        const qty = normalizeNumber(line.qty);
                                        if (qty !== null) {
                                                const conversion = normalizeNumber(line.conversion_factor);
                                                const factor = conversion !== null && conversion !== 0 ? conversion : 1;
                                                stockQty = qty * factor;
                                        }
                                }

                                if (stockQty === null) {
                                        return;
                                }

                                const positiveQty = Math.max(0, stockQty);
                                if (!positiveQty) {
                                        return;
                                }

                                totals[code] = (totals[code] || 0) + positiveQty;
                        };

                        (Array.isArray(this.items) ? this.items : []).forEach(accumulate);
                        (Array.isArray(this.packed_items) ? this.packed_items : []).forEach(accumulate);

                        const impacted = stockCoordinator.updateReservations(totals, {
                                source: "invoice",
                        });
                        if (impacted.length) {
                                this.applyStockStateToInvoiceItems(impacted);
                        }

                        this.eventBus.emit("cart_quantities_updated", totals);
                },
                // Handle item dropped from ItemsSelector to ItemsTable
                handleItemDrop(item) {
                        console.log("Item dropped:", item);

                        // Use the existing add_item method to add the dropped item
                        this.add_item(item);
                },

                applyStockStateToInvoiceItems(codes = null) {
                        const collections = [];
                        if (Array.isArray(this.items)) {
                                collections.push(this.items);
                        }
                        if (Array.isArray(this.packed_items)) {
                                collections.push(this.packed_items);
                        }
                        if (!collections.length) {
                                return;
                        }
                        const codesSet = (() => {
                                if (codes === null) {
                                        return null;
                                }
                                const iterable = Array.isArray(codes)
                                        ? codes
                                        : codes instanceof Set || (codes && typeof codes[Symbol.iterator] === "function")
                                        ? Array.from(codes)
                                        : [codes];
                                return new Set(
                                        iterable
                                                .map((code) =>
                                                        code !== undefined && code !== null
                                                                ? String(code).trim()
                                                                : "",
                                                )
                                                .filter(Boolean),
                                );
                        })();

                        collections.forEach((items) => {
                                stockCoordinator.applyAvailabilityToCollection(items, codesSet, {
                                        updateBaseAvailable: false,
                                });
                        });

                        this.$forceUpdate();
                },
                primeInvoiceStockState(source = "invoice") {
                        const baseItems = [];
                        if (Array.isArray(this.items)) {
                                baseItems.push(...this.items);
                        }
                        if (Array.isArray(this.packed_items)) {
                                baseItems.push(...this.packed_items);
                        }
                        if (!baseItems.length) {
                                return;
                        }

                        stockCoordinator.primeFromItems(baseItems, { silent: true, source });
                        const codes = baseItems
                                .map((item) =>
                                        item && item.item_code !== undefined ? String(item.item_code).trim() : null,
                                )
                                .filter(Boolean);
                        this.applyStockStateToInvoiceItems(codes);
                },
                handleStockCoordinatorUpdate(event = {}) {
                        const codes = Array.isArray(event.codes) ? event.codes : [];
                        if (!codes.length) {
                                return;
                        }
                        this.applyStockStateToInvoiceItems(codes);
                },

                // Show visual feedback when item is being dragged over drop zone
                showDropFeedback(isDragging) {
                        // Add visual feedback class to the items table
                        const itemsTable = this.$el.querySelector(".modern-items-table");
			if (itemsTable) {
				if (isDragging) {
					itemsTable.classList.add("drag-over");
				} else {
					itemsTable.classList.remove("drag-over");
				}
			}
		},
		openPackedItems(bundle_id) {
			this.packed_dialog_items = this.packed_items.filter((it) => it.bundle_id === bundle_id);
			this.show_packed_dialog = true;
		},
		toggleColumnSelection() {
			// Create a copy of selected columns for temporary editing
			this.temp_selected_columns = [...this.selected_columns];
			this.show_column_selector = true;
		},

		cancelColumnSelection() {
			// Discard changes
			this.show_column_selector = false;
		},

		updateHeadersFromSelection() {
			// Generate headers based on selected columns (without closing dialog)
			this.items_headers = this.available_columns.filter(
				(col) => this.selected_columns.includes(col.key) || col.required,
			);
		},

		updateSelectedColumns() {
			// Apply the temporary selection
			this.selected_columns = [...this.temp_selected_columns];

			// Add required columns if they're not already included
			const requiredKeys = this.available_columns.filter((col) => col.required).map((col) => col.key);

			requiredKeys.forEach((key) => {
				if (!this.selected_columns.includes(key)) {
					this.selected_columns.push(key);
				}
			});

			// Update headers
			this.updateHeadersFromSelection();

			// Save preferences
			this.saveColumnPreferences();

			// Close dialog
			this.show_column_selector = false;
		},

		saveColumnPreferences() {
			try {
				localStorage.setItem("posawesome_selected_columns", JSON.stringify(this.selected_columns));
			} catch (e) {
				console.error("Failed to save column preferences:", e);
			}
		},

		loadColumnPreferences() {
			try {
				const saved = localStorage.getItem("posawesome_selected_columns");
				if (saved) {
					this.selected_columns = JSON.parse(saved);
				}
			} catch (e) {
				console.error("Failed to load column preferences:", e);
			}
		},

		saveInvoiceHeight() {
			if (this.$refs.invoiceCard) {
				this.invoiceHeight = this.$refs.invoiceCard.clientHeight + "px";
				try {
					localStorage.setItem("posawesome_invoice_height", this.invoiceHeight);
				} catch (e) {
					console.error("Failed to save invoice height:", e);
				}
			}
		},

		loadInvoiceHeight() {
			try {
				const saved = localStorage.getItem("posawesome_invoice_height");
				if (saved) {
					this.invoiceHeight = saved;
				} else {
					this.invoiceHeight =
						getComputedStyle(document.documentElement).getPropertyValue("--container-height") ||
						"68vh";
				}
			} catch (e) {
				console.error("Failed to load invoice height:", e);
				this.invoiceHeight =
					getComputedStyle(document.documentElement).getPropertyValue("--container-height") ||
					"68vh";
			}
		},
		makeid(length) {
			let result = "";
			const characters = "abcdefghijklmnopqrstuvwxyz0123456789";
			const charactersLength = characters.length;
			for (var i = 0; i < length; i++) {
				result += characters.charAt(Math.floor(Math.random() * charactersLength));
			}
			return result;
		},

		handleExpandedUpdate(ids) {
			this.expanded = Array.isArray(ids) ? ids.slice(-1) : [];
		},
		// VERSION 2.0.2 - Wrapper for save_and_clear_invoice to hide left panel
		async handleSaveAndClear() {
			try {
				const result = await this.save_and_clear_invoice();
				// Hide left panel after successful save & clear
				if (this.eventBus && this.eventBus.emit) {
					this.eventBus.emit("hide-item-panel");
				}
				return result;
			} catch (error) {
				throw error;
			}
		},

                async print_draft_invoice() {
                        if (!this.pos_profile.posa_allow_print_draft_invoices) {
                                this.eventBus.emit("show_message", {
                                        title: __(`You are not allowed to print draft invoices`),
                                        color: "error",
                                });
                                return;
                        }

                        let invoice_name = this.invoice_doc?.name || null;
                        try {
                                const invoice_doc = await this.save_and_clear_invoice();
                                if (invoice_doc?.name) {
                                        invoice_name = invoice_doc.name;
                                }

                                if (!invoice_name) {
                                        throw new Error("Invoice could not be saved before printing");
                                }

                                this.load_print_page(invoice_name);
                        } catch (error) {
                                console.error("Failed to print draft invoice:", error);
                                this.eventBus.emit("show_message", {
                                        title: __("Unable to print draft invoice"),
                                        color: "error",
                                });
                        }
                },
		async set_delivery_charges() {
			var vm = this;
			if (!this.pos_profile || !this.customer || !this.pos_profile.posa_use_delivery_charges) {
				this.delivery_charges = [];
				this.base_delivery_charges_rate = 0;
				this.delivery_charges_rate = 0;
				this.selected_delivery_charge = "";
				return;
			}
			this.base_delivery_charges_rate = 0;
			this.delivery_charges_rate = 0;
			this.selected_delivery_charge = "";
			try {
				const r = await frappe.call({
					method: "posawesome.posawesome.api.offers.get_applicable_delivery_charges",
					args: {
						company: this.pos_profile.company,
						pos_profile: this.pos_profile.name,
						customer: this.customer,
					},
				});
				if (r.message && r.message.length) {
					console.log(r.message);
					vm.delivery_charges = r.message;
				}
			} catch (error) {
				console.error("Failed to fetch delivery charges", error);
			}
		},
		deliveryChargesFilter(itemText, queryText, itemRow) {
			const item = itemRow.raw;
			console.log("dl charges", item);
			const textOne = item.name.toLowerCase();
			const searchText = queryText.toLowerCase();
			return textOne.indexOf(searchText) > -1;
		},
		update_delivery_charges() {
			if (this.selected_delivery_charge) {
				this.base_delivery_charges_rate = this.selected_delivery_charge.rate;
			} else {
				this.base_delivery_charges_rate = 0;
			}
			this.update_delivery_charges_rate();
		},
		update_delivery_charges_rate() {
			if (this.base_delivery_charges_rate) {
				this.delivery_charges_rate = this.flt(
					this.base_delivery_charges_rate / (this.conversion_rate || 1),
					this.currency_precision,
				);
			} else {
				this.delivery_charges_rate = 0;
			}
		},
		updatePostingDate(date) {
			if (!date) return;
			this.posting_date = date;
			this.$forceUpdate();
		},
                shouldEnforceStockLimits(item) {
                        if (!item) {
                                return false;
                        }

                        if (item.is_stock_item === 0) {
                                if (!item.is_bundle) {
                                        return false;
                                }

                                const bundleChildren = this.packed_items.filter(
                                        (ch) => ch.bundle_id === item.bundle_id,
                                );
                                return bundleChildren.some((ch) => ch.is_stock_item !== 0);
                        }

                        return true;
                },
                updateBundleChildrenQty(item) {
                        if (!item || !item.is_bundle) {
                                return;
                        }

                        const multiplier = item.qty || 0;
                        this.packed_items
                                .filter((it) => it.bundle_id === item.bundle_id)
                                .forEach((ch) => {
                                        ch.qty = multiplier * (ch.child_qty_per_bundle || 1);
                                        this.calc_stock_qty(ch, ch.qty);
                                });
                },
                // Override setFormatedFloat for qty field to handle stock limits and return mode
                setFormatedQty(item, field_name, precision, no_negative, value) {
                        // Parse and set the value using the mixin's formatter
                        let parsedValue = this.setFormatedFloat(item, field_name, precision, no_negative, value);

                        const enforceStockLimits = this.shouldEnforceStockLimits(item);
                        // Enforce available stock limits
                        if (
                                enforceStockLimits &&
                                item.max_qty !== undefined &&
                                this.flt(item[field_name]) > this.flt(item.max_qty)
                        ) {
                                const blockSale =
                                        !this.stock_settings.allow_negative_stock || this.blockSaleBeyondAvailableQty;
                                if (blockSale) {
                                        item[field_name] = item.max_qty;
                                        parsedValue = item.max_qty;
                                        this.eventBus.emit("show_message", {
                                                title: __(`Maximum available quantity is {0}. Quantity adjusted to match stock.`, [
							this.formatFloat(item.max_qty),
						]),
						color: "error",
					});
				} else {
					this.eventBus.emit("show_message", {
						title: __("Stock is lower than requested. Proceeding may create negative stock."),
						color: "warning",
					});
				}
			}

                        // Ensure negative value for return invoices
                        if (this.isReturnInvoice && parsedValue > 0) {
                                parsedValue = -Math.abs(parsedValue);
                                item[field_name] = parsedValue;
			}

			// Recalculate stock quantity with the adjusted value
                        this.calc_stock_qty(item, item[field_name]);
                        if (field_name === "qty") {
                                this.updateBundleChildrenQty(item);
                        }
                        return parsedValue;
                },
		async fetch_available_currencies() {
			try {
				console.log("Fetching available currencies...");
				const r = await frappe.call({
					method: "posawesome.posawesome.api.invoices.get_available_currencies",
				});

				if (r.message) {
					console.log("Received currencies:", r.message);

					// Get base currency for reference
					const baseCurrency = this.pos_profile.currency;

					// Create simple currency list with just names
					this.available_currencies = r.message.map((currency) => {
						return {
							value: currency.name,
							title: currency.name,
						};
					});

					// Sort currencies - base currency first, then others alphabetically
					this.available_currencies.sort((a, b) => {
						if (a.value === baseCurrency) return -1;
						if (b.value === baseCurrency) return 1;
						return a.value.localeCompare(b.value);
					});

					// Set default currency if not already set
					if (!this.selected_currency) {
						this.selected_currency = baseCurrency;
					}

					return this.available_currencies;
				}

				return [];
			} catch (error) {
				console.error("Error fetching currencies:", error);
				// Set default currency as fallback
				const defaultCurrency = this.pos_profile.currency;
				this.available_currencies = [
					{
						value: defaultCurrency,
						title: defaultCurrency,
					},
				];
				this.selected_currency = defaultCurrency;
				return this.available_currencies;
			}
		},

		async fetch_price_lists() {
			if (this.pos_profile.posa_enable_price_list_dropdown) {
				try {
					const r = await frappe.call({
						method: "posawesome.posawesome.api.utilities.get_selling_price_lists",
					});
					if (r && r.message) {
						this.price_lists = r.message.map((pl) => pl.name);
					}
				} catch (error) {
					console.error("Failed fetching price lists", error);
					this.price_lists = [this.pos_profile.selling_price_list];
				}
			} else {
				// Fallback to the price list defined in the POS Profile
				this.price_lists = [this.pos_profile.selling_price_list];
			}

			if (!this.selected_price_list) {
				this.selected_price_list = this.pos_profile.selling_price_list;
			}

			// Fetch and store currency for the applied price list
			try {
				const r = await frappe.call({
					method: "posawesome.posawesome.api.invoices.get_price_list_currency",
					args: { price_list: this.selected_price_list },
				});
				if (r && r.message) {
					this.price_list_currency = r.message;
				}
			} catch (error) {
				console.error("Failed fetching price list currency", error);
			}

			return this.price_lists;
		},

		async update_currency(currency) {
			if (!currency) return;
			this.selected_currency = currency;
			await this.update_currency_and_rate();
		},

		update_exchange_rate() {
			if (!this.exchange_rate || this.exchange_rate <= 0) {
				this.exchange_rate = 1;
			}

			// Emit currency update
			this.eventBus.emit("update_currency", {
				currency: this.selected_currency || this.pos_profile.currency,
				exchange_rate: this.exchange_rate,
			});

			this.update_item_rates();
		},

		update_conversion_rate() {
			if (!this.conversion_rate || this.conversion_rate <= 0) {
				this.conversion_rate = 1;
			}

			this.sync_exchange_rate();
		},

		update_item_rates() {
			console.log("Updating item rates with exchange rate:", this.exchange_rate);

			this.items.forEach((item) => {
				// Set skip flag to avoid double calculations
				item._skip_calc = true;

				// First ensure base rates exist for all items
				if (!item.base_rate) {
					console.log(`Setting base rates for ${item.item_code} for the first time`);
					const baseCurrency = this.price_list_currency || this.pos_profile.currency;
					if (this.selected_currency === baseCurrency) {
						// When in base currency, base rates = displayed rates
						item.base_rate = item.rate;
						item.base_price_list_rate = item.price_list_rate;
						item.base_discount_amount = item.discount_amount || 0;
					} else {
						// When in another currency, calculate base rates
						item.base_rate = item.rate / this.exchange_rate;
						item.base_price_list_rate = item.price_list_rate / this.exchange_rate;
						item.base_discount_amount = (item.discount_amount || 0) / this.exchange_rate;
					}
				}

				// Currency conversion logic
				const baseCurrency = this.price_list_currency || this.pos_profile.currency;
				if (this.selected_currency === baseCurrency) {
					// When switching back to default currency, restore from base rates
					console.log(`Restoring rates for ${item.item_code} from base rates`);
					item.price_list_rate = item.base_price_list_rate;
					item.rate = item.base_rate;
					item.discount_amount = item.base_discount_amount;
				} else if (item.original_currency === this.selected_currency) {
					// When selected currency matches the price list currency,
					// no conversion should be applied
					console.log(`Using original currency rates for ${item.item_code}`);
					item.price_list_rate = item.base_price_list_rate;
					item.rate = item.base_rate;
					item.discount_amount = item.base_discount_amount;
				} else {
					// When switching to another currency, convert from base rates
					console.log(`Converting rates for ${item.item_code} to ${this.selected_currency}`);

					// Convert base currency values to the selected currency
					const converted_price = this.flt(
						item.base_price_list_rate * this.exchange_rate,
						this.currency_precision,
					);
					const converted_rate = this.flt(
						item.base_rate * this.exchange_rate,
						this.currency_precision,
					);
					const converted_discount = this.flt(
						item.base_discount_amount * this.exchange_rate,
						this.currency_precision,
					);

					// Ensure we don't set values to 0 if they're just very small
					item.price_list_rate = converted_price < 0.000001 ? 0 : converted_price;
					item.rate = converted_rate < 0.000001 ? 0 : converted_rate;
					item.discount_amount = converted_discount < 0.000001 ? 0 : converted_discount;
				}

				// Always recalculate final amounts
				item.amount = this.flt(item.qty * item.rate, this.currency_precision);
				item.base_amount = this.flt(item.qty * item.base_rate, this.currency_precision);

				console.log(`Updated rates for ${item.item_code}:`, {
					price_list_rate: item.price_list_rate,
					base_price_list_rate: item.base_price_list_rate,
					rate: item.rate,
					base_rate: item.base_rate,
					discount: item.discount_amount,
					base_discount: item.base_discount_amount,
					amount: item.amount,
					base_amount: item.base_amount,
				});

				// Apply any other pricing rules if needed
				this.calc_item_price(item);
			});

			// Force UI update after all calculations
			this.$forceUpdate();
		},

		formatCurrency(value, precision = null) {
			const prec = precision != null ? precision : this.currency_precision;
			return this.$options.mixins[0].methods.formatCurrency.call(this, value, prec);
		},

		flt(value, precision = null) {
			// Enhanced float handling for small numbers
			if (precision === null) {
				precision = this.float_precision;
			}

			const _value = Number(value);
			if (isNaN(_value)) {
				return 0;
			}

			// Handle very small numbers to prevent them from becoming 0
			if (Math.abs(_value) < 0.000001) {
				return _value;
			}

			return Number((_value || 0).toFixed(precision));
		},

		// Update currency and exchange rate when currency is changed
		async update_currency_and_rate() {
			if (!this.selected_currency) return;

			const companyCurrency =
				(this.company && this.company.default_currency) || this.pos_profile.currency;
			const priceListCurrency = this.price_list_currency || companyCurrency;

			try {
				// Price list currency to selected currency rate
				if (this.selected_currency === priceListCurrency) {
					this.exchange_rate = 1;
				} else {
					const r = await frappe.call({
						method: "posawesome.posawesome.api.invoices.fetch_exchange_rate_pair",
						args: {
							from_currency: priceListCurrency,
							to_currency: this.selected_currency,
						},
					});
					if (r && r.message) {
						this.exchange_rate = r.message.exchange_rate;
					}
				}

				// Selected currency to company currency rate
				if (this.selected_currency === companyCurrency) {
					this.conversion_rate = 1;
					this.exchange_rate_date = this.formatDateForBackend(this.posting_date_display);
				} else {
					const r2 = await frappe.call({
						method: "posawesome.posawesome.api.invoices.fetch_exchange_rate_pair",
						args: {
							from_currency: this.selected_currency,
							to_currency: companyCurrency,
						},
					});
					if (r2 && r2.message) {
						this.conversion_rate = r2.message.exchange_rate;
						this.exchange_rate_date = r2.message.date;
						const posting_backend = this.formatDateForBackend(this.posting_date_display);
						if (this.exchange_rate_date && posting_backend !== this.exchange_rate_date) {
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
			} catch (error) {
				console.error("Error updating currency:", error);
				this.eventBus.emit("show_message", {
					title: "Error updating currency",
					color: "error",
				});
			}

			this.sync_exchange_rate();

			// If items already exist, update the invoice on the server so that
			// the document currency and rates remain consistent
			if (this.items.length) {
				const doc = this.get_invoice_doc();
				doc.currency = this.selected_currency;
				doc.price_list_currency = priceListCurrency || this.pos_profile.currency;
				doc.conversion_rate = this.conversion_rate;
				doc.plc_conversion_rate = this.exchange_rate;
				try {
					await this.update_invoice(doc);
				} catch (error) {
					console.error("Error updating invoice currency:", error);
					this.eventBus.emit("show_message", {
						title: "Error updating currency",
						color: "error",
					});
				}
			}
		},

		async update_exchange_rate_on_server() {
			if (this.conversion_rate) {
				if (!this.items.length) {
					this.sync_exchange_rate();
					return;
				}

				const doc = this.get_invoice_doc();
				doc.conversion_rate = this.conversion_rate;
				doc.plc_conversion_rate = this.exchange_rate;
				try {
					const resp = await this.update_invoice(doc);
					if (resp && resp.exchange_rate_date) {
						this.exchange_rate_date = resp.exchange_rate_date;
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
					this.sync_exchange_rate();
				} catch (error) {
					console.error("Error updating exchange rate:", error);
					this.eventBus.emit("show_message", {
						title: "Error updating exchange rate",
						color: "error",
					});
				}
			}
		},

		sync_exchange_rate() {
			if (!this.exchange_rate || this.exchange_rate <= 0) {
				this.exchange_rate = 1;
			}
			if (!this.conversion_rate || this.conversion_rate <= 0) {
				this.conversion_rate = 1;
			}

			// Emit currency update
			this.eventBus.emit("update_currency", {
				currency: this.selected_currency || this.pos_profile.currency,
				exchange_rate: this.exchange_rate,
				conversion_rate: this.conversion_rate,
			});

			this.update_item_rates();
			this.update_delivery_charges_rate();
		},

		// Add new rounding function
		roundAmount(amount) {
			// Respect POS Profile setting to disable rounding
			if (this.pos_profile.disable_rounded_total) {
				// Use configured precision without applying rounding
				return this.flt(amount, this.currency_precision);
			}
			// If multi-currency is enabled and selected currency is different from base currency
			const baseCurrency = this.price_list_currency || this.pos_profile.currency;
			if (this.pos_profile.posa_allow_multi_currency && this.selected_currency !== baseCurrency) {
				// For multi-currency, just keep 2 decimal places without rounding to nearest integer
				return this.flt(amount, 2);
			}
			// For base currency or when multi-currency is disabled, round to nearest integer
			return Math.round(amount);
		},

		// Increase quantity of an item (handles return logic)
                add_one(item) {
                        const enforceStockLimits = this.shouldEnforceStockLimits(item);
                        if (this.isReturnInvoice) {
                                // For returns, make quantity more negative
                                item.qty--;
                        } else {
                                const proposed = item.qty + 1;
                                const blockSale =
                                        enforceStockLimits &&
                                        (!this.stock_settings.allow_negative_stock || this.blockSaleBeyondAvailableQty);
                                const exceedsAvailable =
                                        enforceStockLimits && item.max_qty !== undefined && proposed > item.max_qty;
                                if (blockSale && exceedsAvailable) {
                                        item.qty = item.max_qty;
                                        this.calc_stock_qty(item, item.qty);
                                        this.eventBus.emit("show_message", {
                                                title: __("Maximum available quantity is {0}. Quantity adjusted to match stock.", [
							this.formatFloat(item.max_qty),
						]),
						color: "error",
					});
					return;
				}
				if (!blockSale && exceedsAvailable) {
					this.eventBus.emit("show_message", {
						title: __(
							`{0}: requested quantity exceeds available stock. Negative stock is allowed—proceed carefully.`,
							[item.item_name || item.item_code],
						),
						color: "warning",
					});
                                }
                                item.qty = proposed;
                        }
                        if (item.qty == 0) {
                                this.remove_item(item);
                        }
                        this.calc_stock_qty(item, item.qty);
                        this.updateBundleChildrenQty(item);
                        this.$forceUpdate();
                },

                // Decrease quantity of an item (handles return logic)
                subtract_one(item) {
			if (this.isReturnInvoice) {
				// For returns, move quantity toward zero
				item.qty++;
			} else {
				item.qty--;
                        }
                        if (item.qty == 0) {
                                this.remove_item(item);
                        }
                        this.calc_stock_qty(item, item.qty);
                        this.updateBundleChildrenQty(item);
                        this.$forceUpdate();
                },

		// Handle item reordering from drag and drop
                handleItemReorder(reorderData) {
                        const { fromIndex, toIndex } = reorderData;

                        if (fromIndex === toIndex) return;

			// Create a copy of the items array
			const newItems = [...this.items];

			// Remove the item from its original position
			const [movedItem] = newItems.splice(fromIndex, 1);

			// Insert the item at its new position
			newItems.splice(toIndex, 0, movedItem);

			// Update the items array
			this.items = newItems;

			// Show success feedback
			this.eventBus.emit("show_message", {
				title: __("Item order updated"),
				color: "success",
			});

                        // Optionally, you can also update the idx field for each item
                        this.items.forEach((item, index) => {
                                item.idx = index + 1;
                        });
                },
                handleRegisterPosProfile(data) {
                        this.pos_profile = data.pos_profile;
                        this.company = data.company || null;
                        this.customer = data.pos_profile.customer;
                        this.pos_opening_shift = data.pos_opening_shift;
                        this.stock_settings = data.stock_settings;
                        const prec = parseInt(data.pos_profile.posa_decimal_precision);
                        if (!isNaN(prec)) {
                                this.float_precision = prec;
                                this.currency_precision = prec;
                        }
                        this.invoiceType = this.pos_profile.posa_default_sales_order ? "Order" : "Invoice";
                        this.initializeItemsHeaders();

                        if (this.pos_profile.posa_allow_multi_currency) {
                                this.fetch_available_currencies()
                                        .then(async () => {
                                                this.selected_currency = this.pos_profile.currency;
                                                await this.update_currency_and_rate();
                                        })
                                        .catch((error) => {
                                                console.error("Error initializing currencies:", error);
                                                this.eventBus.emit("show_message", {
                                                        title: __("Error loading currencies"),
                                                        color: "error",
                                                });
                                        });
                        }

                        this.fetch_price_lists();
                        this.update_price_list();
                },
                handleClearInvoice() {
                        this.clear_invoice();
                        this.eventBus.emit("focus_item_search");
                },
                handleLoadInvoice(data) {
                        this.load_invoice(data);
                },
                handleLoadOrder(data) {
                        this.new_order(data);
                        // this.eventBus.emit("set_pos_coupons", data.posa_coupons);
                },
                handleSetOffers(data) {
                        this.posOffers = data;
                },
                handleUpdateInvoiceOffers(data) {
                        this.updateInvoiceOffers(data);
                },
                handleUpdateInvoiceCoupons(data) {
                        this.posa_coupons = data;
                        this.handelOffers();
                },
                handleSetAllItems(data) {
                        this.allItems = data;
                        this.items.forEach((item) => {
                                if (item._detailSynced !== true) {
                                        this.update_item_detail(item);
                                }
                        });
                        this.primeInvoiceStockState();
                },
                handleLoadReturnInvoice(data) {
                        console.log("Invoice component received load_return_invoice event with data:", data);
                        this.load_invoice(data.invoice_doc);
                        this.invoiceType = "Return";
                        this.invoiceTypes = ["Return"];
                        this.invoice_doc.is_return = 1;
                        if (this.items && this.items.length) {
                                this.items.forEach((item) => {
                                        if (item.qty > 0) item.qty = -Math.abs(item.qty);
                                        if (item.stock_qty > 0) item.stock_qty = -Math.abs(item.stock_qty);
                                });
                        }
                        if (data.return_doc) {
                                console.log("Return against existing invoice:", data.return_doc.name);
                                this.discount_amount = data.return_doc.discount_amount || 0;
                                this.additional_discount = data.return_doc.discount_amount || 0;
                                this.return_doc = data.return_doc;
                                this.invoice_doc.return_against = data.return_doc.name;
                        } else {
                                console.log("Return without invoice reference");
                                this.discount_amount = 0;
                                this.additional_discount = 0;
                                this.additional_discount_percentage = 0;
                        }
                        console.log("Invoice state after loading return:", {
                                invoiceType: this.invoiceType,
                                is_return: this.invoice_doc.is_return,
                                items: this.items.length,
                                customer: this.customer,
                        });
                },
                handleSetNewLine(data) {
                        this.new_line = data;
                },
                handleResetPostingDate() {
                        this.posting_date = frappe.datetime.nowdate();
                },
                handleItemDragStart() {
                        this.showDropFeedback(true);
                },
                handleItemDragEnd() {
                        this.showDropFeedback(false);
                },
                handleShowPayment(data) {
                        this.paymentVisible = data === "true";
                },
		async loadFatehPosSettings() {
			try {
				const res = await frappe.call({
					method: "frappe.client.get",
					args: {
						doctype: "Fateh POS Settings",
						name: "Fateh POS Settings",
					},
				});
				const msg = res?.message || {};
				this.enableQuickItemSearch = Boolean(msg.enable_quick_item_search);
				// Load quick customers
				this.quickCustomers = Array.isArray(msg.quick_customers) ? msg.quick_customers : [];
			} catch (error) {
				console.warn("Could not load Fateh POS Settings:", error);
				this.enableQuickItemSearch = false;
				this.quickCustomers = [];
			}
		},
		selectQuickCustomer(customerName) {
			// Select customer using the store
			this.customersStore.setSelectedCustomer(customerName);
			// Update the customer component if available
			if (this.$refs.customerComponent && this.$refs.customerComponent.internalCustomer !== undefined) {
				this.$nextTick(() => {
					this.$refs.customerComponent.internalCustomer = customerName;
				});
			}
		},
		async onQuickItemSearch(term) {
			if (!this.enableQuickItemSearch) return;

			const txt = (term || "").trim();
			this.quickItemSearch = txt;

			try {
				let results = [];

				if (txt) {
					// Fetch a larger set of items and filter client-side (like ItemsSelector does)
					// This ensures both item_code and item_name searches work reliably
					const res = await frappe.call({
						method: "frappe.client.get_list",
						args: {
							doctype: "Item",
							fields: ["item_code", "item_name"],
							filters: { disabled: 0 },
							limit: 1000, // Fetch more items for client-side filtering
							order_by: "item_name asc",
						},
					});

					let fetchedItems = Array.isArray(res?.message) ? res.message : [];

					// Client-side filtering - same logic as ItemsSelector
					// Split search term into words for word-by-word matching
					const searchLower = txt.toLowerCase().trim();
					const searchWords = searchLower.split(/\s+/).filter(w => w.length > 0);

					if (searchWords.length > 0) {
						results = fetchedItems.filter((item) => {
							const name = (item.item_name || "").toLowerCase();
							const code = (item.item_code || "").toLowerCase();

							// Match if all search words are found in either item_code or item_name
							// This works for both item_code (substring match) and item_name (word-by-word match)
							return searchWords.every((word) => {
								// Check item_code - substring match (works for "asl" matching "ASL")
								if (code.includes(word)) {
									return true;
								}
								// Check item_name - full string or word-by-word match
								if (name.includes(word)) {
									return true;
								}
								// Check word-by-word in item_name
								const nameWords = name.split(/\s+/);
								return nameWords.some(nw => nw.includes(word));
							});
						});
					} else {
						results = fetchedItems;
					}
				} else {
					const res = await frappe.call({
						method: "frappe.client.get_list",
						args: {
							doctype: "Item",
							fields: ["item_code", "item_name"],
							filters: { disabled: 0 },
							limit: 20,
							order_by: "item_name asc",
						},
					});
					results = Array.isArray(res?.message) ? res.message : [];
				}

				this.quickItemOptions = results.map((item) => ({
					title: item.item_code, // item_code for autocomplete internal use
					value: item.item_code,
					item_code: item.item_code,
					item_name: item.item_name || item.item_code,
				}));
			} catch (e) {
				console.error("Quick item search failed", e);
				this.quickItemOptions = [];
			}
		},
		onQuickItemFocus() {
			if (!this.quickItemOptions.length) {
				this.onQuickItemSearch("");
			}
		},
		async onQuickItemSelected(option) {
			if (!option) {
				this.quickItemSelection = null;
				return;
			}
			const itemCode = option.value || option.item_code || option;
			
			// Use scan_barcode event - ItemsSelector handles it properly
			// It finds the item (by item_code or barcode), fetches full details, and adds it
			// This ensures item_name and all other fields are populated correctly
			this.eventBus.emit("scan_barcode", itemCode);
			
			// Clear selection immediately
			this.quickItemSelection = null;
			this.quickItemSearch = "";
			this.quickItemOptions = [];
			
			// Refocus the quick item search field after adding item
			// Use sufficient delay to ensure scan_barcode processing completes
			this.$nextTick(() => {
				if (this.$refs.quickItemSearchInput) {
					const input = this.$refs.quickItemSearchInput.$el.querySelector('input');
					if (input) {
						setTimeout(() => {
							input.focus();
						}, 300);
					}
				}
			});
		},
		onQuickItemEnter() {
			if (this.quickItemOptions && this.quickItemOptions.length) {
				this.onQuickItemSelected(this.quickItemOptions[0]);
			}
		},
        },

		async mounted() {
			await this.loadFatehPosSettings();

			// Load saved column preferences
			this.loadColumnPreferences();
			// Restore saved invoice height
			this.loadInvoiceHeight();

                this._busHandlers = {
                        "item-drag-start": this.handleItemDragStart,
                        "item-drag-end": this.handleItemDragEnd,
                        register_pos_profile: this.handleRegisterPosProfile,
                        add_item: this.add_item,
                        clear_invoice: this.handleClearInvoice,
                        load_invoice: this.handleLoadInvoice,
                        load_order: this.handleLoadOrder,
                        set_offers: this.handleSetOffers,
                        update_invoice_offers: this.handleUpdateInvoiceOffers,
                        update_invoice_coupons: this.handleUpdateInvoiceCoupons,
                        set_all_items: this.handleSetAllItems,
                        load_return_invoice: this.handleLoadReturnInvoice,
                        set_new_line: this.handleSetNewLine,
                        reset_posting_date: this.handleResetPostingDate,
                        calc_uom: this.calc_uom,
                        show_payment: this.handleShowPayment,
                        "scan-error": this.handleScanErrorFromItemsSelector,
                        "scan-success": this.handleScanSuccess,
                        "scan-error-acknowledged": this.handleScanErrorAcknowledged, // VERSION 2.0.3 - Unlock scanner when ItemsSelector acknowledges error
                };

                Object.entries(this._busHandlers).forEach(([eventName, handler]) => {
                        this.eventBus.on(eventName, handler);
                });

                this.stockUnsubscribe = stockCoordinator.subscribe(this.handleStockCoordinatorUpdate);

                if (this.pos_profile.posa_allow_multi_currency) {
                        this.fetch_available_currencies();
                }

                this.emitCartQuantities();
                this.$nextTick(() => {
                        this.primeInvoiceStockState();
                });
        },
        // Cleanup event listeners before component is destroyed
        beforeUnmount() {
                if (typeof this.stockUnsubscribe === "function") {
                        this.stockUnsubscribe();
                        this.stockUnsubscribe = null;
                }

                Object.entries(this._busHandlers || {}).forEach(([eventName, handler]) => {
                        this.eventBus.off(eventName, handler);
                });
                this._busHandlers = {};
                if (typeof this.cancelScheduledOfferRefresh === "function") {
                        this.cancelScheduledOfferRefresh();
                }
                if (this._suppressClosePaymentsTimer) {
                        clearTimeout(this._suppressClosePaymentsTimer);
                        this._suppressClosePaymentsTimer = null;
                }
                if (this.scanDebounceId) {
                        clearTimeout(this.scanDebounceId);
                        this.scanDebounceId = null;
                }
                if (this.scanAudioContext) {
                        try {
                                this.scanAudioContext.close();
                        } catch (error) {
                                console.warn("Scan audio context close failed:", error);
                        }
                        this.scanAudioContext = null;
                }
        },
	// Register global keyboard shortcuts when component is created
	created() {
		this.invoiceStore.clear();
		this.$watch(
			() => this.selectedCustomer,
			(newCustomer) => {
				if (newCustomer) {
					if (this.customer !== newCustomer) {
						this.customer = newCustomer;
					}
				} else if (this.customer) {
					this.customer = "";
				}
			},
			{ immediate: true },
		);
		this.$watch(
			() => this.customerRefreshToken,
			() => {
				if (this.customer) {
					this.fetch_customer_details();
				}
			},
		);
                this._shortcutHandlers = this._shortcutHandlers || {};

                this._shortcutHandlers.shortOpenPayment = this.shortOpenPayment.bind(this);
                this._shortcutHandlers.shortDeleteFirstItem = this.shortDeleteFirstItem.bind(this);
                this._shortcutHandlers.shortOpenFirstItem = this.shortOpenFirstItem.bind(this);
                this._shortcutHandlers.shortSelectDiscount = this.shortSelectDiscount.bind(this);
                this._shortcutHandlers.shortFocusCustomer = this.shortFocusCustomer.bind(this);
                this._shortcutHandlers.shortFocusItem = this.shortFocusItem.bind(this);

                document.addEventListener("keydown", this._shortcutHandlers.shortOpenPayment);
                document.addEventListener("keydown", this._shortcutHandlers.shortDeleteFirstItem);
                document.addEventListener("keydown", this._shortcutHandlers.shortOpenFirstItem);
                document.addEventListener("keydown", this._shortcutHandlers.shortSelectDiscount);
                document.addEventListener("keydown", this._shortcutHandlers.shortFocusCustomer);
                document.addEventListener("keydown", this._shortcutHandlers.shortFocusItem);
        },
        // Remove global keyboard shortcuts when component is unmounted
        unmounted() {
                if (!this._shortcutHandlers) {
                        return;
                }

                document.removeEventListener("keydown", this._shortcutHandlers.shortOpenPayment);
                document.removeEventListener("keydown", this._shortcutHandlers.shortDeleteFirstItem);
                document.removeEventListener("keydown", this._shortcutHandlers.shortOpenFirstItem);
                document.removeEventListener("keydown", this._shortcutHandlers.shortSelectDiscount);
                document.removeEventListener("keydown", this._shortcutHandlers.shortFocusCustomer);
                document.removeEventListener("keydown", this._shortcutHandlers.shortFocusItem);

                this._shortcutHandlers = {};
        },
	watch: invoiceWatchers,
};
</script>

<style scoped>
/* Card background adjustments */
.cards {
	background-color: var(--surface-secondary) !important;
}

/* Style for selected checkbox button */
.v-checkbox-btn.v-selected {
	background-color: var(--submit-start) !important;
	color: white;
}

/* Bottom border for elements */
.border_line_bottom {
	border-bottom: 1px solid var(--field-border);
}

/* Disable pointer events for elements */
.disable-events {
	pointer-events: none;
}

/* Style for customer balance field */
:deep(.balance-field) {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	flex-wrap: nowrap;
}

/* Style for balance value text */
:deep(.balance-value) {
	font-size: 1.5rem;
	font-weight: bold;
	color: var(--primary-start);
	margin-left: var(--dynamic-xs);
}

/* Red border and label for return mode card */

/* Red border and label for return mode card */

.return-mode {
	border: 2px solid rgb(var(--v-theme-error)) !important;
	position: relative;
}

/* Label for return mode card */
.return-mode::before {
	content: "RETURN";
	position: absolute;
	top: 0;
	right: 0;
	background-color: rgb(var(--v-theme-error));
	color: white;
	padding: 4px 12px;
	font-weight: bold;
	border-bottom-left-radius: 8px;
	z-index: 1;
}

/* Dynamic padding for responsive layout */
.dynamic-padding {
	/* Uniform spacing for better alignment */
	padding: var(--dynamic-sm);
}

/* Responsive breakpoints */
@media (max-width: 768px) {
	.dynamic-padding {
		/* Smaller uniform padding on tablets */
		padding: var(--dynamic-xs);
	}

	.dynamic-padding .v-row {
		margin: 0 -2px;
	}

	.dynamic-padding .v-col {
		padding: 2px 4px;
	}

	.items-table-wrapper {
		/* Adjust for smaller padding on tablets */
		margin-left: calc(-1 * var(--dynamic-xs));
		margin-right: calc(-1 * var(--dynamic-xs));
		width: calc(100% + 2 * var(--dynamic-xs));
		max-width: calc(100% + 2 * var(--dynamic-xs));
	}

	.item-search-field {
		max-width: 100%;
	}
}

@media (max-width: 480px) {
	.dynamic-padding {
		padding: var(--dynamic-xs);
	}

	.dynamic-padding .v-row {
		margin: 0 -1px;
	}

	.dynamic-padding .v-col {
		padding: 1px 2px;
	}

	.items-table-wrapper {
		/* Adjust for smallest screens */
		margin-left: calc(-1 * var(--dynamic-xs));
		margin-right: calc(-1 * var(--dynamic-xs));
		width: calc(100% + 2 * var(--dynamic-xs));
		max-width: calc(100% + 2 * var(--dynamic-xs));
	}

	.item-search-field {
		flex-basis: 100%;
		max-width: 100%;
		margin-right: 0;
	}
}

.column-selector-container {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	flex-wrap: wrap;
	gap: 8px;
	padding: 8px 16px;
	background-color: var(--pos-card-bg);
	border-radius: 8px 8px 0 0;
	box-sizing: border-box;
	margin-bottom: 8px;
}

.search-fields-container {
	display: flex;
	align-items: center;
	gap: 8px;
	flex: 1 1 auto;
	margin-right: auto;
	min-width: 0;
}

.item-search-field {
	flex: 1 1 0;
	min-width: 200px;
	max-width: 400px;
}

.column-selector-btn {
	font-size: 0.875rem;
}

.items-table-wrapper {
	position: relative;
	margin-top: var(--dynamic-sm);
	/* Override parent padding to make table full-width */
	margin-left: calc(-1 * var(--dynamic-sm));
	margin-right: calc(-1 * var(--dynamic-sm));
	width: calc(100% + 2 * var(--dynamic-sm));
	max-width: calc(100% + 2 * var(--dynamic-sm));
	box-sizing: border-box;
}

/* New styles for improved column switches */
:deep(.column-switch) {
	margin: 0;
	padding: 0;
}

:deep(.column-switch .v-switch__track) {
	opacity: 0.7;
}

:deep(.column-switch .v-switch__thumb) {
	transform: scale(0.8);
}

:deep(.column-switch .v-label) {
	opacity: 0.9;
	font-size: 0.95rem;
}

.manual-scan-container {
	padding: 16px;
	border-radius: 12px;
	border: 1px solid var(--pos-border, rgba(0, 0, 0, 0.08));
	background-color: var(--pos-card-bg, rgba(255, 255, 255, 0.96));
	box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45);
	transition:
		background-color 0.2s ease,
		border-color 0.2s ease;
	margin-bottom: 8px;
}

.manual-scan-text .text-body-2 {
	color: rgba(0, 0, 0, 0.6);
}

:deep(.v-theme--dark) .manual-scan-container {
	background-color: rgba(30, 30, 30, 0.92);
	border-color: rgba(255, 255, 255, 0.12);
	box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

:deep(.v-theme--dark) .manual-scan-text .text-body-2 {
	color: rgba(255, 255, 255, 0.7);
}

.scan-error-dialog {
	border-radius: 16px;
}

.scan-error-dialog .scan-error-message {
	font-weight: 600;
	font-size: 1.05rem;
	margin: 0;
}

.scan-error-dialog .scan-error-code {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	font-family:
		"Roboto Mono", "Fira Code", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono",
		"Courier New", monospace;
	font-size: 0.95rem;
	padding: 6px 10px;
	border-radius: 6px;
	background-color: rgba(244, 67, 54, 0.12);
}

.scan-error-dialog .scan-error-details {
	margin-top: 12px;
	color: rgba(0, 0, 0, 0.72);
	line-height: 1.4;
}

:deep(.v-theme--dark) .scan-error-dialog .scan-error-code {
	background-color: rgba(244, 67, 54, 0.25);
	color: #ffebee;
}

:deep(.v-theme--dark) .scan-error-dialog .scan-error-details {
	color: rgba(255, 255, 255, 0.7);
}

.version-indicator {
	font-size: 0.65rem !important;
}

/* Quick Customer Buttons */
.quick-customer-btn {
	min-width: auto !important;
	white-space: nowrap;
	font-size: 0.75rem;
	padding: 8px 16px !important;
	min-height: 36px !important;
	display: flex !important;
	align-items: center !important;
	justify-content: center !important;
	text-align: center !important;
}

.gap-1 {
	gap: 4px;
}

.gap-2 {
	gap: 4px;
}
</style>
