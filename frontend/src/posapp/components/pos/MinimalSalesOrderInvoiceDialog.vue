<template>
	<v-row justify="center">
		<v-dialog v-model="dialog" persistent max-width="900px">
			<v-card>
				<v-card-title class="text-h5 text-primary">
					{{ __("Create Sales Invoice from Order") }}
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
								<div class="text-subtitle-1 mb-2">
									{{ __("Items") }}
									<v-chip size="small" color="info" class="ml-2">
									{{ __("Advance Paid:") }} {{ currencySymbolValue }}
									{{ formatCurrency(advance_paid) }}
									</v-chip>
								</div>
								<v-data-table
									:headers="itemHeaders"
									:items="items"
									item-key="name"
									density="compact"
									class="elevation-1"
								>
									<template v-slot:item.item_code="{ item }">
										<v-text-field
											v-model="item.item_code"
											variant="outlined"
											density="compact"
											hide-details
											:placeholder="__('Item Code')"
										></v-text-field>
									</template>
									<template v-slot:item.item_name="{ item }">
										<v-text-field
											v-model="item.item_name"
											variant="outlined"
											density="compact"
											hide-details
											:placeholder="__('Item Name')"
										></v-text-field>
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
								</v-data-table>
							</v-col>
						</v-row>
						
						<v-row>
							<v-col cols="12">
								<v-alert type="info" dense>
									{{ __("Advance amount will be automatically deducted from the paid amount") }}
								</v-alert>
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
						@click="submitInvoice"
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
			sales_order_name: "",
			customer_name: "",
			mobile_no: "",
			items: [],
			advance_paid: 0,
			pos_profile: null,
			isSubmitting: false,
			errorMessage: "",
			itemHeaders: [
				{ title: __("Item Code"), key: "item_code", sortable: false },
				{ title: __("Item Name"), key: "item_name", sortable: false },
				{ title: __("Qty"), key: "qty", sortable: false, width: "100px" },
				{ title: __("Rate"), key: "rate", sortable: false, width: "150px" },
			],
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
				this.items.every(item => item.item_code && item.qty > 0)
			);
		},
	},
	methods: {
		closeDialog() {
			this.dialog = false;
			this.resetForm();
		},
		resetForm() {
			this.sales_order_name = "";
			this.customer_name = "";
			this.mobile_no = "";
			this.items = [];
			this.advance_paid = 0;
			this.errorMessage = "";
		},
		async loadSalesOrder() {
			if (!this.sales_order_name) return;
			
			try {
				// Load sales order details
				const so_doc = await frappe.get_doc("Sales Order", this.sales_order_name);
				
				// Get advance payment amount
				const { message: advanceRefs } = await frappe.call({
					method: "frappe.client.get_list",
					args: {
						doctype: "Payment Entry Reference",
						filters: {
							reference_doctype: "Sales Order",
							reference_name: this.sales_order_name,
						},
						fields: ["parent", "allocated_amount"],
					},
				});
				
				let totalAdvance = 0;
				for (const ref of advanceRefs || []) {
					try {
						const pe = await frappe.get_doc("Payment Entry", ref.parent);
						if (pe.docstatus === 1) {
							totalAdvance += parseFloat(ref.allocated_amount || 0);
						}
					} catch (e) {
						console.error("Error loading payment entry:", e);
					}
				}
				this.advance_paid = totalAdvance;
				
				// Load items from sales order
				this.items = (so_doc.items || []).map(item => ({
					item_code: item.item_code,
					item_name: item.item_name,
					qty: item.qty,
					rate: item.rate,
					uom: item.uom,
					warehouse: item.warehouse,
				}));
			} catch (error) {
				console.error("Failed to load sales order:", error);
				this.errorMessage = error.message || __("Failed to load sales order");
			}
		},
		async submitInvoice() {
			if (!this.canSubmit || this.isSubmitting) return;
			
			this.isSubmitting = true;
			this.errorMessage = "";
			
			try {
				const { message } = await frappe.call({
					method: "posawesome.posawesome.api.minimal_sales_orders.create_sales_invoice_from_minimal_order",
					args: {
						sales_order_name: this.sales_order_name,
						items: JSON.stringify(this.items),
						customer_name: this.customer_name,
						mobile_no: this.mobile_no,
					},
				});
				
				// Load the invoice in POS
				this.eventBus.emit("load_invoice", message);
				
				frappe.show_alert({
					message: __("Sales Invoice created successfully"),
					indicator: "green",
				}, 3);
				
				this.closeDialog();
			} catch (error) {
				console.error("Failed to create invoice:", error);
				this.errorMessage = error.message || __("Failed to create invoice");
			} finally {
				this.isSubmitting = false;
			}
		},
	},
	created() {
		this.eventBus.on("open_minimal_sales_order_invoice", async (data) => {
			this.sales_order_name = data?.sales_order;
			this.customer_name = data?.customer_name || "";
			this.mobile_no = data?.mobile_no || "";
			this.pos_profile = data?.pos_profile;
			this.dialog = true;
			await this.loadSalesOrder();
		});
	},
	beforeUnmount() {
		this.eventBus.off("open_minimal_sales_order_invoice");
	},
};
</script>

