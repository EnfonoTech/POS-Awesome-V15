<template>
	<v-row justify="center">
		<v-dialog v-model="dialog" persistent max-width="800px">
			<v-card>
				<v-card-title class="text-h5 text-primary">
					{{ __("Create Minimal Sales Order") }}
				</v-card-title>
				<v-card-text>
					<v-container>
						<v-row>
							<v-col cols="12" md="6">
								<v-text-field
									v-model="customer_name"
									:label="__('Customer Name')"
									required
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
												variant="outlined"
												density="compact"
												hide-details
												:placeholder="__('Search Item')"
												clearable
												no-data-text="No items found"
												style="flex: 1;"
											>
												<template v-slot:item="{ props, item: itemData }">
													<v-list-item v-bind="props">
														<template v-slot:title>
															{{ itemData.raw.item_name || itemData.raw.item_code }}
														</template>
														<template v-slot:subtitle>
															{{ __("Code") }}: {{ itemData.raw.item_code }} | {{ __("Group") }}: {{ itemData.raw.item_group }}
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
			payment_modes: [],
			pos_profile: null,
			isSubmitting: false,
			errorMessage: "",
			itemHeaders: [
				{ title: __("Item"), key: "item_name", sortable: false },
				{ title: __("Qty"), key: "qty", sortable: false, width: "100px" },
				{ title: __("Rate"), key: "rate", sortable: false, width: "150px" },
				{ title: __("Actions"), key: "actions", sortable: false, width: "80px" },
			],
			itemCounter: 0,
			itemSearchCache: {}, // Cache for item search results
		};
	},
	computed: {
		currencySymbolValue() {
			return this.pos_profile?.currency ? this.currencySymbol(this.pos_profile.currency) : "";
		},
		canSubmit() {
			return (
				this.customer_name &&
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
	methods: {
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
		async searchItem(searchTerm, tempId) {
			// Validate search term
			if (!searchTerm || typeof searchTerm !== 'string') {
				const item = this.items.find(i => i.temp_id === tempId);
				if (item) {
					item.searchResults = [];
					item.searchTerm = "";
				}
				return;
			}
			
			searchTerm = searchTerm.trim();
			
			if (searchTerm.length < 2) {
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
						search_term: searchTerm,
						limit: 20,
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
				}
			} else {
				// User cleared the selection - allow manual entry
				item.item_code = "";
				item.selected_item = null;
				// Keep item_name if it was manually entered
			}
		},
		async loadPaymentModes() {
			if (!this.pos_profile) return;
			
			// Get payment modes directly from pos_profile.payments
			if (this.pos_profile && this.pos_profile.payments && Array.isArray(this.pos_profile.payments)) {
				this.payment_modes = this.pos_profile.payments.map(p => ({
					mode_of_payment: p.mode_of_payment || p.mode_of_payment,
					type: p.type || null,
				})).filter(p => p.mode_of_payment); // Filter out any null/undefined
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
							company: this.pos_profile?.company,
							pos_profile: this.pos_profile?.name,
						},
					},
				});
				
				frappe.show_alert({
					message: __("Sales Order created successfully"),
					indicator: "green",
				}, 3);
				
				this.closeDialog();
				this.eventBus.emit("minimal_sales_order_created", message);
			} catch (error) {
				console.error("Failed to create sales order:", error);
				this.errorMessage = error.message || __("Failed to create sales order");
			} finally {
				this.isSubmitting = false;
			}
		},
	},
	created() {
		this.eventBus.on("open_minimal_sales_order", async (data) => {
			this.pos_profile = data?.pos_profile;
			this.dialog = true;
			await this.loadPaymentModes();
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

