<template>
	<v-row justify="center">
		<v-dialog v-model="dialog" persistent max-width="1200px">
			<v-card>
				<v-card-title class="text-h5 text-primary">
					{{ __("Create New Order") }}
				</v-card-title>
				<v-card-text>
					<v-container>
						<v-row>
							<v-col cols="12" md="6">
								<v-text-field
									v-model="customer_name"
									:label="__('Customer Name')"
									variant="outlined"
									density="compact"
									prepend-inner-icon="mdi-account"
								></v-text-field>
							</v-col>
							<v-col cols="12" md="6">
								<v-text-field
									v-model="mobile_no"
									:label="__('Customer Number / Mobile')"
									variant="outlined"
									density="compact"
									prepend-inner-icon="mdi-phone"
								></v-text-field>
							</v-col>
						</v-row>
						
						<v-row>
							<v-col cols="12">
								<div class="text-subtitle-1 mb-2">{{ __("Items") }}</div>
								<v-data-table
									:headers="itemHeaders"
									:items="items"
									item-key="temp_id"
									density="compact"
									class="elevation-1"
								>
									<template v-slot:item.item_name="{ item }">
										<div style="display: flex; gap: 8px;">
									<v-autocomplete
										v-model="item.selected_item"
										:items="item.searchResults"
										:item-title="item => item.item_name ? `${item.item_name} (${item.item_code})` : item.item_code"
										:item-value="item => item.item_code"
										:search="item.searchTerm"
										@update:search="(val) => searchItem(val, item.temp_id)"
										@update:model-value="(val) => selectItem(val, item.temp_id)"
										@focus="loadDefaultItems(item.temp_id)"
										variant="outlined"
										density="compact"
										hide-details
										:placeholder="__('Search Item')"
										clearable
										:no-data-text="__('No items found')"
										style="flex: 1;"
									>
												<template v-slot:item="{ props, item: itemData }">
													<v-list-item v-bind="props">
														<template v-slot:title>
															{{ itemData.raw.item_name || itemData.raw.item_code }}
														</template>
														<template v-slot:subtitle>
															{{ __("Code") }}: {{ itemData.raw.item_code }} | {{ __("Group") }}: {{ itemData.raw.item_group }}
															<span v-if="itemData.raw.price_list_rate"> | {{ __("Price") }}: {{ currencySymbolValue }}{{ formatPrice(itemData.raw.price_list_rate) }}</span>
														</template>
													</v-list-item>
												</template>
											</v-autocomplete>
											<v-text-field
												v-model="item.item_name"
												variant="outlined"
												density="compact"
												hide-details
												:placeholder="__('Or Enter New Item')"
												style="flex: 1;"
												:disabled="!!item.selected_item"
											></v-text-field>
										</div>
									</template>
									<template v-slot:item.qty="{ item }">
										<v-text-field
											v-model.number="item.qty"
											type="number"
											variant="outlined"
											density="compact"
											hide-details
											:placeholder="__('Qty')"
										></v-text-field>
									</template>
									<template v-slot:item.rate="{ item }">
										<v-text-field
											v-model.number="item.rate"
											type="number"
											variant="outlined"
											density="compact"
											hide-details
											:prefix="currencySymbolValue"
											:placeholder="__('Rate')"
										></v-text-field>
									</template>
									<template v-slot:item.amount="{ item }">
										<div class="text-right font-weight-medium">
											{{ currencySymbolValue }}{{ formatPrice(calculateItemAmount(item)) }}
										</div>
									</template>
									<template v-slot:item.actions="{ item }">
										<v-btn
											icon="mdi-delete"
											size="small"
											variant="text"
											color="error"
											@click="removeItem(item.temp_id)"
										></v-btn>
									</template>
								</v-data-table>
								<v-btn
									class="mt-2"
									color="primary"
									variant="outlined"
									prepend-icon="mdi-plus"
									@click="addItem"
								>
									{{ __("Add Item") }}
								</v-btn>
								
								<!-- Total Amount Display -->
								<div class="d-flex justify-end mt-3">
									<v-card variant="outlined" style="min-width: 280px;">
										<v-card-text class="py-2 px-3">
											<v-row dense align="center" no-gutters>
												<v-col cols="6" class="text-right font-weight-medium">
													{{ __("Total Amount") }}:
												</v-col>
												<v-col cols="6" class="text-right">
													<span class="text-h6 font-weight-bold primary--text">
														{{ currencySymbolValue }}{{ formatPrice(totalAmount) }}
													</span>
												</v-col>
											</v-row>
										</v-card-text>
									</v-card>
								</div>
							</v-col>
						</v-row>
						
						<v-row>
							<v-col cols="12" md="6">
								<v-text-field
									v-model.number="advance_amount"
									:label="__('Advance Amount')"
									type="number"
									variant="outlined"
									density="compact"
									:prefix="currencySymbolValue"
									prepend-inner-icon="mdi-cash"
								></v-text-field>
							</v-col>
							<v-col cols="12" md="6" v-if="advance_amount > 0">
								<v-autocomplete
									v-model="mode_of_payment"
									:items="payment_modes"
									:item-title="item => item.mode_of_payment"
									:item-value="item => item.mode_of_payment"
									:label="__('Mode of Payment')"
									variant="outlined"
									density="compact"
									prepend-inner-icon="mdi-credit-card"
									required
								></v-autocomplete>
							</v-col>
						</v-row>
						
						<v-row>
							<v-col cols="12">
								<v-textarea
									v-model="additional_notes"
									:label="__('Additional Notes')"
									variant="outlined"
									density="compact"
									rows="3"
									prepend-inner-icon="mdi-note-text"
									:placeholder="__('Enter any additional notes or remarks')"
								></v-textarea>
							</v-col>
						</v-row>
						
						<v-alert v-if="errorMessage" type="error" dense class="mt-2">
							{{ errorMessage }}
						</v-alert>
					</v-container>
				</v-card-text>
				<v-card-actions>
					<v-spacer></v-spacer>
					<v-btn color="error" @click="closeDialog">{{ __("Cancel") }}</v-btn>
					<v-btn
						color="success"
						:loading="isSubmitting"
						:disabled="isSubmitting || !canSubmit"
						@click="submitOrder"
					>
						{{ __("Create Order") }}
					</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</v-row>
</template>

<script>
/* global __, frappe */
import format from "../../format";

export default {
	mixins: [format],
	data() {
		return {
			dialog: false,
			customer_name: "",
			mobile_no: "",
			items: [],
			advance_amount: 0,
			mode_of_payment: "",
			additional_notes: "",
			payment_modes: [],
			pos_profile: null,
			isSubmitting: false,
			errorMessage: "",
			itemHeaders: [
				{ title: __("Item"), key: "item_name", sortable: false },
				{ title: __("Qty"), key: "qty", sortable: false, width: "100px" },
				{ title: __("Rate"), key: "rate", sortable: false, width: "180px" },
				{ title: __("Amount"), key: "amount", sortable: false, width: "150px", align: "end" },
				{ title: __("Actions"), key: "actions", sortable: false, width: "80px" },
			],
			itemCounter: 0,
			itemSearchCache: {}, // Cache for item search results
			fatehPosSettings: {}, // Fateh POS Settings data
		};
	},
	computed: {
		currencySymbolValue() {
			return this.pos_profile?.currency ? this.currencySymbol(this.pos_profile.currency) : "";
		},
		totalAmount() {
			return this.items.reduce((total, item) => {
				return total + this.calculateItemAmount(item);
			}, 0);
		},
		canSubmit() {
			return (
				(this.customer_name || this.mobile_no) &&
				this.items.length > 0 &&
				this.items.every(item => {
					// Either item is selected (item_code) or new item name is entered
					const hasItem = item.selected_item || (item.item_name && item.item_name.trim());
					return hasItem && item.qty > 0;
				}) &&
				(this.advance_amount === 0 || (this.advance_amount > 0 && this.mode_of_payment))
			);
		},
	},
	watch: {
		advance_amount(newVal) {
			// Auto-select default payment mode when advance amount is entered
			if (newVal > 0 && !this.mode_of_payment) {
				const defaultPayment = this.payment_modes.find(p => p.default === 1);
				if (defaultPayment) {
					this.mode_of_payment = defaultPayment.mode_of_payment;
				} else if (this.payment_modes.length > 0) {
					// If no default, select first available
					this.mode_of_payment = this.payment_modes[0].mode_of_payment;
				}
			}
		},
	},
	methods: {
		async loadFatehPosSettings() {
			try {
				const res = await frappe.call({
					method: "frappe.client.get",
					args: {
						doctype: "Fateh POS Settings",
						name: "Fateh POS Settings",
					},
				});
				this.fatehPosSettings = res?.message || {};
			} catch (error) {
				console.warn("Could not load Fateh POS Settings:", error);
				this.fatehPosSettings = {};
			}
		},
		closeDialog() {
			this.dialog = false;
			this.resetForm();
		},
		resetForm() {
			this.customer_name = "";
			this.mobile_no = "";
			this.items = [];
			this.advance_amount = 0;
			this.mode_of_payment = "";
			this.additional_notes = "";
			this.errorMessage = "";
			this.itemCounter = 0;
			this.itemSearchCache = {};
		},
		addItem() {
			this.items.push({
				temp_id: ++this.itemCounter,
				item_code: "",
				item_name: "",
				item_group: "",
				stock_uom: "",
				selected_item: null,
				qty: 1,
				rate: 0,
				searchResults: [],
				searchTerm: "",
			});
		},
		removeItem(temp_id) {
			this.items = this.items.filter(item => item.temp_id !== temp_id);
			// Clean up search cache
			delete this.itemSearchCache[temp_id];
		},
		async loadDefaultItems(tempId) {
			// Load default items when autocomplete is focused (if not already loaded)
			const item = this.items.find(i => i.temp_id === tempId);
			if (!item) return;
			
			// If already has results, don't reload
			if (item.searchResults && item.searchResults.length > 0) return;
			
			// Load default items (empty search returns top items)
			await this.searchItem("", tempId, true);
		},
		async searchItem(searchTerm, tempId, forceLoad = false) {
			// Validate search term
			if (!searchTerm || typeof searchTerm !== 'string') {
				const item = this.items.find(i => i.temp_id === tempId);
				if (item) {
					// If forceLoad is true, fetch default items
					if (forceLoad) {
						searchTerm = "";
					} else {
						item.searchResults = [];
						item.searchTerm = "";
						return;
					}
				} else {
					return;
				}
			}
			
			searchTerm = searchTerm.trim();
			
			// Allow empty search term when forceLoad is true to get default items
			if (searchTerm.length < 2 && !forceLoad) {
				const item = this.items.find(i => i.temp_id === tempId);
				if (item) {
					item.searchResults = [];
					item.searchTerm = searchTerm;
				}
				return;
			}
			
			// Check cache first
			const cacheKey = `${tempId}_${searchTerm}`;
			if (this.itemSearchCache[cacheKey]) {
				const item = this.items.find(i => i.temp_id === tempId);
				if (item) {
					item.searchResults = this.itemSearchCache[cacheKey];
					item.searchTerm = searchTerm;
				}
				return;
			}
			
			try {
				const { message } = await frappe.call({
					method: "posawesome.posawesome.api.minimal_sales_orders.search_items",
					args: {
						search_term: searchTerm || "",
						limit: 20,
						pos_profile: this.pos_profile?.name,
					},
				});
				
				const item = this.items.find(i => i.temp_id === tempId);
				if (item) {
					item.searchResults = message || [];
					item.searchTerm = searchTerm;
					// Cache the results
					this.itemSearchCache[cacheKey] = message || [];
				}
			} catch (error) {
				console.error("Failed to search items:", error);
				const item = this.items.find(i => i.temp_id === tempId);
				if (item) {
					item.searchResults = [];
					item.searchTerm = searchTerm;
				}
			}
		},
		selectItem(itemCode, tempId) {
			const item = this.items.find(i => i.temp_id === tempId);
			if (!item) return;
			
			if (itemCode) {
				// Item was selected from list
				const selectedItem = item.searchResults.find(i => i.item_code === itemCode);
				if (selectedItem) {
					item.item_code = selectedItem.item_code;
					item.item_name = selectedItem.item_name;
					item.item_group = selectedItem.item_group;
					item.stock_uom = selectedItem.stock_uom;
					item.selected_item = itemCode;
					// Set the price list rate if available
					if (selectedItem.price_list_rate) {
						item.rate = selectedItem.price_list_rate;
					}
				}
			} else {
				// User cleared the selection - allow manual entry
				item.item_code = "";
				item.selected_item = null;
				// Keep item_name if it was manually entered
			}
		},
		calculateItemAmount(item) {
			const qty = parseFloat(item.qty) || 0;
			const rate = parseFloat(item.rate) || 0;
			return qty * rate;
		},
		formatPrice(price) {
			return parseFloat(price || 0).toFixed(2);
		},
		async loadPaymentModes() {
			if (!this.pos_profile) return;
			
			// Get payment modes directly from pos_profile.payments
			if (this.pos_profile && this.pos_profile.payments && Array.isArray(this.pos_profile.payments)) {
				this.payment_modes = this.pos_profile.payments.map(p => ({
					mode_of_payment: p.mode_of_payment || p.mode_of_payment,
					type: p.type || null,
					default: p.default || 0,
				})).filter(p => p.mode_of_payment); // Filter out any null/undefined
				
				// Set default mode of payment from POS Profile
				const defaultPayment = this.payment_modes.find(p => p.default === 1);
				if (defaultPayment && !this.mode_of_payment) {
					this.mode_of_payment = defaultPayment.mode_of_payment;
				}
				return;
			}
			
			// Fallback: try API call
			try {
				const { message } = await frappe.call({
					method: "posawesome.posawesome.api.minimal_sales_orders.get_pos_profile_payment_modes",
					args: {
						pos_profile_data: this.pos_profile,
					},
				});
				this.payment_modes = message || [];
				
				// Set default mode of payment
				const defaultPayment = this.payment_modes.find(p => p.default === 1);
				if (defaultPayment && !this.mode_of_payment) {
					this.mode_of_payment = defaultPayment.mode_of_payment;
				}
			} catch (error) {
				console.error("Failed to load payment modes:", error);
				this.payment_modes = [];
			}
		},
		async submitOrder() {
			if (!this.canSubmit || this.isSubmitting) return;
			
			this.isSubmitting = true;
			this.errorMessage = "";
			
			try {
				const { message } = await frappe.call({
					method: "posawesome.posawesome.api.minimal_sales_orders.create_minimal_sales_order",
					args: {
						data: {
							customer_name: this.customer_name,
							mobile_no: this.mobile_no,
							items: this.items,
							advance_amount: this.advance_amount,
							mode_of_payment: this.mode_of_payment,
							additional_notes: this.additional_notes,
							company: this.pos_profile?.company,
							pos_profile: this.pos_profile?.name,
							set_warehouse: this.pos_profile?.warehouse || this.pos_profile?.set_warehouse,
						},
					},
				});
				
				frappe.show_alert({
					message: __("Sales Order created successfully"),
					indicator: "green",
				}, 3);
				
				this.closeDialog();
				this.eventBus.emit("minimal_sales_order_created", message);
				
				// Auto-print the sales order without leaving POS
				if (message && message.name) {
					let url =
						frappe.urllib.get_base_url() +
						"/printview?doctype=" +
						encodeURIComponent("Sales Order") +
						"&name=" +
						encodeURIComponent(message.name) +
						"&trigger_print=1";
					
					// Add print format if configured in Fateh POS Settings
					if (this.fatehPosSettings?.sales_order_print_format) {
						url += "&format=" + encodeURIComponent(this.fatehPosSettings.sales_order_print_format);
					}
					
					// Open print in new window, auto-print, then close
					const printWindow = window.open(url, "_blank");
					if (printWindow) {
						// Wait for print dialog to finish, then close the window
						printWindow.addEventListener("afterprint", function() {
							printWindow.close();
						});
						// Fallback: close after a delay if afterprint doesn't fire
						setTimeout(() => {
							try {
								if (printWindow && !printWindow.closed) {
									printWindow.close();
								}
							} catch (e) {
								console.log("Print window already closed");
							}
						}, 2000);
					}
				}
			} catch (error) {
				console.error("Failed to create sales order:", error);
				this.errorMessage = error.message || __("Failed to create sales order");
			} finally {
				this.isSubmitting = false;
			}
		},
	},
	async created() {
		// Load Fateh POS Settings on component creation
		await this.loadFatehPosSettings();
		
		this.eventBus.on("open_minimal_sales_order", async (data) => {
			this.pos_profile = data?.pos_profile;
			this.dialog = true;
			await this.loadPaymentModes(); // This will set default mode of payment
			
			// Add default item if available
			if (data?.default_item) {
				this.items.push({
					temp_id: ++this.itemCounter,
					item_code: data.default_item,
					item_name: data.default_item,
					item_group: "",
					stock_uom: "",
					selected_item: data.default_item,
					qty: 1,
					rate: 0,
					searchResults: [],
					searchTerm: "",
				});
			} else {
				// Always add at least one empty item row
				this.addItem();
			}
		});
	},
	beforeUnmount() {
		this.eventBus.off("open_minimal_sales_order");
	},
};
</script>

