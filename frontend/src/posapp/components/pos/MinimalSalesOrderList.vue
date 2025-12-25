<template>
	<v-row justify="center">
		<v-dialog v-model="dialog" max-width="1000px" persistent>
			<v-card>
				<v-card-title class="text-h5 text-primary">
					{{ __("Sales Orders List") }}
				</v-card-title>
				<v-card-text>
					<v-container>
						<v-row class="mb-4">
							<v-col cols="12" md="4">
								<v-text-field
									v-model="searchCustomerName"
									:label="__('Customer Name')"
									variant="outlined"
									density="compact"
									clearable
									prepend-inner-icon="mdi-account"
								></v-text-field>
							</v-col>
							<v-col cols="12" md="4">
								<v-text-field
									v-model="searchMobileNo"
									:label="__('Mobile Number')"
									variant="outlined"
									density="compact"
									clearable
									prepend-inner-icon="mdi-phone"
								></v-text-field>
							</v-col>
							<v-col cols="12" md="4">
								<v-btn
									color="primary"
									:loading="isLoading"
									:disabled="isLoading"
									@click="searchOrders"
									prepend-icon="mdi-magnify"
								>
									{{ __("Search") }}
								</v-btn>
							</v-col>
						</v-row>
						
						<v-alert v-if="errorMessage" type="error" dense class="mb-2">
							{{ errorMessage }}
						</v-alert>
						
						<v-data-table
							:headers="headers"
							:items="orders"
							item-key="name"
							class="elevation-1"
							:loading="isLoading"
							show-select
							v-model="selected"
							return-object
							select-strategy="single"
						>
							<template v-slot:item.grand_total="{ item }">
								{{ currencySymbol(item.currency) }}
								{{ formatCurrency(item.grand_total) }}
							</template>
							<template v-slot:item.transaction_date="{ item }">
								{{ formatDate(item.transaction_date) }}
							</template>
						</v-data-table>
					</v-container>
				</v-card-text>
				<v-card-actions>
					<v-spacer></v-spacer>
					<v-btn color="error" @click="closeDialog">{{ __("Close") }}</v-btn>
					<v-btn
						color="success"
						:disabled="selected.length === 0"
						:loading="isCreatingInvoice"
						@click="createInvoice"
					>
						{{ __("Create Invoice") }}
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
			orders: [],
			selected: [],
			searchCustomerName: "",
			searchMobileNo: "",
			isLoading: false,
			isCreatingInvoice: false,
			errorMessage: "",
			pos_profile: null,
			headers: [
				{ title: __("ID"), key: "name", sortable: true },
				{ title: __("Customer Name"), key: "customer_name", sortable: true },
				{ title: __("Mobile Number"), key: "mobile_no", sortable: false },
				{ title: __("Date"), key: "transaction_date", sortable: true },
				{ title: __("Amount"), key: "grand_total", sortable: false, align: "end" },
			],
		};
	},
	methods: {
		formatDate(date) {
			if (!date) return "";
			return frappe.datetime.str_to_user(date);
		},
		closeDialog() {
			this.dialog = false;
			this.orders = [];
			this.selected = [];
			this.searchCustomerName = "";
			this.searchMobileNo = "";
			this.errorMessage = "";
		},
		async searchOrders() {
			if (this.isLoading) return;
			
			this.isLoading = true;
			this.errorMessage = "";
			
			try {
				const { message } = await frappe.call({
					method: "posawesome.posawesome.api.minimal_sales_orders.list_minimal_sales_orders",
					args: {
						company: this.pos_profile?.company,
						customer_name: this.searchCustomerName || null,
						mobile_no: this.searchMobileNo || null,
					},
				});
				
				this.orders = message || [];
			} catch (error) {
				console.error("Failed to search orders:", error);
				this.errorMessage = error.message || __("Failed to search orders");
			} finally {
				this.isLoading = false;
			}
		},
		async createInvoice() {
			if (this.selected.length === 0 || this.isCreatingInvoice) return;
			
			this.isCreatingInvoice = true;
			this.errorMessage = "";
			
			try {
				const order = this.selected[0];
				
				// Get sales order data
				const { message } = await frappe.call({
					method: "posawesome.posawesome.api.minimal_sales_orders.get_sales_order_data_for_invoice",
					args: {
						sales_order_name: order.name,
					},
				});
				
				if (!message) {
					throw new Error(__("Failed to load sales order data"));
				}
				
				// Load data into POS invoice
				const invoiceData = {
					customer: message.customer,
					customer_name: message.customer_name,
					mobile_no: message.mobile_no,
					items: message.items || [],
					advance_paid: message.advance_paid || 0,
					sales_order: message.sales_order,
					company: message.company,
					currency: message.currency,
				};
				
				// Emit event to load invoice with sales order data
				this.eventBus.emit("load_sales_order_to_invoice", invoiceData);
				
				this.closeDialog();
				
				frappe.show_alert({
					message: __("Sales order loaded. Advance amount: {0}", [this.formatCurrency(message.advance_paid || 0)]),
					indicator: "green",
				}, 3);
			} catch (error) {
				console.error("Failed to load sales order:", error);
				this.errorMessage = error.message || __("Failed to load sales order");
			} finally {
				this.isCreatingInvoice = false;
			}
		},
	},
	created() {
		this.eventBus.on("open_minimal_sales_order_list", (data) => {
			this.pos_profile = data?.pos_profile;
			this.dialog = true;
			this.searchOrders();
		});
	},
	beforeUnmount() {
		this.eventBus.off("open_minimal_sales_order_list");
	},
};
</script>

