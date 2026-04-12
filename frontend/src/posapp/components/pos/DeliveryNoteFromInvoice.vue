<template>
	<div class="delivery-note-from-invoice">
		<div class="dn-page-header pa-4 pb-2 d-flex flex-wrap align-center gap-3">
			<h1 class="text-h5 font-weight-bold mb-0">{{ __("Delivery Note") }}</h1>
			<v-spacer />
			<v-btn
				color="primary"
				variant="tonal"
				prepend-icon="mdi-refresh"
				@click="refreshInvoices"
				:loading="loading"
			>
				{{ __("Refresh") }}
			</v-btn>
		</div>

		<v-card class="pos-themed-card mb-4 mx-0" variant="outlined">
			<v-card-text class="pt-4 pb-4">
				<v-row dense>
					<v-col cols="12" sm="6" md="3">
						<v-text-field
							v-model="filters.invoice_name"
							:label="__('Invoice number')"
							variant="outlined"
							density="compact"
							clearable
							hide-details
							prepend-inner-icon="mdi-magnify"
							@update:model-value="debouncedSearch"
						/>
					</v-col>
					<v-col cols="12" sm="6" md="4">
						<v-autocomplete
							v-model="customerFilter"
							:items="customerOptions"
							:loading="customerSearchLoading"
							item-title="description"
							item-value="value"
							return-object
							clearable
							hide-details
							density="compact"
							variant="outlined"
							:label="__('Customer')"
							prepend-inner-icon="mdi-account-search"
							:no-data-text="__('Type to search customers')"
							@update:search="onCustomerSearchDebounced"
							@focus="onCustomerSearchImmediate('')"
							@update:model-value="onCustomerFilterChange"
						/>
					</v-col>
					<v-col cols="12" sm="6" md="2">
						<v-text-field
							v-model="filters.from_date"
							:label="__('From date')"
							variant="outlined"
							density="compact"
							type="date"
							clearable
							hide-details
							@update:model-value="debouncedSearch"
						/>
					</v-col>
					<v-col cols="12" sm="6" md="2">
						<v-text-field
							v-model="filters.to_date"
							:label="__('To date')"
							variant="outlined"
							density="compact"
							type="date"
							clearable
							hide-details
							@update:model-value="debouncedSearch"
						/>
					</v-col>
				</v-row>
			</v-card-text>
		</v-card>

		<v-card class="pos-themed-card dn-table-card mx-0" variant="outlined">
			<v-data-table
				:headers="headers"
				:items="invoices"
				:loading="loading"
				:items-per-page="itemsPerPage"
				class="dn-data-table"
				density="comfortable"
				:no-data-text="__('No invoices pending delivery for this POS')"
				:loading-text="__('Loading...')"
				hide-default-footer
			>
				<template #item.name="{ item }">
					<div class="font-weight-medium">{{ item.name }}</div>
					<div class="text-caption text-medium-emphasis">{{ item.doctype }}</div>
				</template>
				<template #item.status="{ item }">
					<v-chip :color="getStatusColor(item.status)" size="small" label>
						{{ getStatusText(item.status) }}
					</v-chip>
				</template>
				<template #item.customer_name="{ item }">
					<div>{{ item.customer_name }}</div>
					<div v-if="item.customer" class="text-caption text-medium-emphasis">{{ item.customer }}</div>
				</template>
				<template #item.posting_date="{ item }">
					{{ formatDate(item.posting_date) }}
				</template>
				<template #item.grand_total="{ item }">
					<div class="text-right font-weight-medium" v-html="formatCurrency(item.grand_total, item.currency)" />
				</template>
				<template #item.actions="{ item }">
					<div class="dn-actions d-flex flex-wrap gap-1 justify-center">
						<v-btn
							color="primary"
							variant="tonal"
							size="small"
							class="text-none"
							prepend-icon="mdi-package-variant"
							:loading="previewLoading === item.name"
							:disabled="!!creating || !!previewLoading || item.is_return"
							@click="openDeliveryPreview(item)"
						>
							{{ __("Items & stock") }}
						</v-btn>
						<v-btn
							color="primary"
							variant="flat"
							size="small"
							class="text-none"
							prepend-icon="mdi-truck-plus"
							:loading="creating === item.name"
							:disabled="!!creating || !!previewLoading || item.is_return"
							@click="createDeliveryNote(item)"
						>
							{{ __("Create DN") }}
						</v-btn>
					</div>
				</template>
			</v-data-table>
			<v-divider />
			<div class="d-flex justify-end align-center pa-3 gap-3 flex-wrap">
				<span class="text-caption text-medium-emphasis">{{ __("Rows per page") }}</span>
				<v-select
					v-model="itemsPerPage"
					:items="[10, 20, 25, 50]"
					variant="outlined"
					density="compact"
					hide-details
					style="max-width: 96px"
					@update:model-value="changeItemsPerPage"
				/>
			</div>
		</v-card>

		<!-- Items & warehouse stock before creating DN -->
		<v-dialog v-model="showPreviewDialog" max-width="900" scrollable>
			<v-card v-if="previewPayload" class="pos-themed-card">
				<v-card-title class="d-flex align-center flex-wrap gap-2 pa-4">
					<v-icon color="primary">mdi-warehouse</v-icon>
					<span class="text-h6">{{ __("Items & stock") }}</span>
					<v-spacer />
					<v-btn icon variant="text" density="comfortable" @click="showPreviewDialog = false">
						<v-icon>mdi-close</v-icon>
					</v-btn>
				</v-card-title>
				<v-divider />
				<v-card-text class="pa-4">
					<div class="text-body-2 mb-1">
						<span class="font-weight-medium">{{ previewPayload.invoice_name }}</span>
						<span class="text-medium-emphasis"> · {{ previewPayload.customer_name }}</span>
					</div>
					<div v-if="previewPayload.set_warehouse" class="text-caption text-medium-emphasis mb-4">
						{{ __("Default warehouse") }}: {{ previewPayload.set_warehouse }}
					</div>
					<v-data-table
						:headers="previewHeaders"
						:items="previewPayload.lines || []"
						density="compact"
						hide-default-footer
						class="border rounded"
						:items-per-page="Math.max((previewPayload.lines || []).length, 1)"
					>
						<template #item.item_display="{ item }">
							<div>
								<div class="font-weight-medium">{{ item.item_name }}</div>
								<div class="text-caption text-medium-emphasis">{{ item.item_code }}</div>
								<div v-if="item.batch_no" class="text-caption">{{ __("Batch") }}: {{ item.batch_no }}</div>
							</div>
						</template>
						<template #item.warehouse="{ item }">
							{{ item.warehouse || "—" }}
						</template>
						<template #item.qty_to_deliver="{ item }">
							<span class="font-weight-medium">{{ formatQty(item.qty_to_deliver) }}</span>
							<span v-if="item.uom" class="text-caption text-medium-emphasis"> {{ item.uom }}</span>
						</template>
						<template #item.stock_in_warehouse="{ item }">
							<span
								:class="{
									'text-warning': item.is_stock_item && stockLooksLow(item),
								}"
							>
								{{ formatStockInWarehouse(item) }}
							</span>
						</template>
					</v-data-table>
					<v-alert
						v-if="!(previewPayload.lines || []).length"
						type="info"
						variant="tonal"
						density="compact"
						class="mt-2"
					>
						{{ __("No lines left to deliver for this invoice.") }}
					</v-alert>
				</v-card-text>
				<v-card-actions class="pa-4 pt-0">
					<v-spacer />
					<v-btn variant="text" @click="showPreviewDialog = false">{{ __("Close") }}</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<!-- Created Delivery Note — stay in POS (no desk redirect) -->
		<v-dialog v-model="showDnDialog" max-width="720" scrollable>
			<v-card v-if="dnSummary" class="pos-themed-card">
				<v-card-title class="d-flex align-center flex-wrap gap-2 pa-4">
					<v-icon color="success">mdi-check-circle</v-icon>
					<span class="text-h6">{{ __("Delivery Note submitted") }}</span>
					<v-spacer />
					<v-btn icon variant="text" density="comfortable" @click="showDnDialog = false">
						<v-icon>mdi-close</v-icon>
					</v-btn>
				</v-card-title>
				<v-divider />
				<v-card-text class="pa-4">
					<v-row dense class="mb-4">
						<v-col cols="12" sm="6">
							<div class="text-caption text-medium-emphasis">{{ __("Delivery Note") }}</div>
							<div class="text-h6 font-weight-bold text-primary">{{ dnSummary.name }}</div>
						</v-col>
						<v-col cols="12" sm="6">
							<div class="text-caption text-medium-emphasis">{{ __("Date") }}</div>
							<div class="text-body-1">{{ formatDate(dnSummary.posting_date) }}</div>
						</v-col>
						<v-col cols="12">
							<div class="text-caption text-medium-emphasis">{{ __("Customer") }}</div>
							<div class="text-body-1 font-weight-medium">{{ dnSummary.customer_name }}</div>
							<div v-if="dnSummary.customer" class="text-caption text-medium-emphasis">
								{{ dnSummary.customer }}
							</div>
						</v-col>
					</v-row>

					<div class="text-subtitle-2 mb-2">{{ __("Items") }}</div>
					<v-data-table
						:headers="dnDialogHeaders"
						:items="dnSummary.items || []"
						density="compact"
						hide-default-footer
						class="dn-dialog-items border rounded"
						:items-per-page="Math.max((dnSummary.items || []).length, 1)"
					>
						<template #item.item_display="{ item }">
							<div>
								<div class="font-weight-medium">{{ item.item_name }}</div>
								<div class="text-caption text-medium-emphasis">{{ item.item_code }}</div>
							</div>
						</template>
						<template #item.qty_display="{ item }">
							<span>{{ formatQty(item.qty) }}</span>
							<span v-if="item.uom" class="text-caption text-medium-emphasis"> {{ item.uom }}</span>
						</template>
						<template #item.rate="{ item }">
							<span class="d-block text-end" v-html="formatCurrency(item.rate, dnSummary.currency)" />
						</template>
						<template #item.amount="{ item }">
							<span class="d-block text-end font-weight-medium" v-html="formatCurrency(item.amount, dnSummary.currency)" />
						</template>
					</v-data-table>

					<v-divider class="my-4" />

					<div class="dn-totals">
						<div class="d-flex justify-space-between py-1">
							<span class="text-medium-emphasis">{{ __("Net total") }}</span>
							<span v-html="formatCurrency(dnSummary.net_total, dnSummary.currency)" />
						</div>
						<div class="d-flex justify-space-between py-1">
							<span class="text-medium-emphasis">{{ __("Tax") }}</span>
							<span v-html="formatCurrency(dnSummary.total_taxes_and_charges, dnSummary.currency)" />
						</div>
						<div class="d-flex justify-space-between py-2 text-h6 font-weight-bold border-t mt-2">
							<span>{{ __("Grand total") }}</span>
							<span v-html="formatCurrency(dnSummary.grand_total, dnSummary.currency)" />
						</div>
					</div>

					<v-alert type="success" variant="tonal" density="compact" class="mt-4 mb-0">
						{{ __("The Delivery Note is submitted and stock has been updated.") }}
					</v-alert>
				</v-card-text>
				<v-card-actions class="pa-4 pt-0">
					<v-spacer />
					<v-btn color="primary" variant="flat" @click="showDnDialog = false">{{ __("Done") }}</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</div>
</template>

<script>
/* global frappe, __ */
import { isOffline } from "../../../offline/index.js";

export default {
	name: "DeliveryNoteFromInvoice",
	props: {
		posProfile: {
			type: Object,
			default: () => ({}),
		},
	},
	data() {
		return {
			loading: false,
			invoices: [],
			currentPage: 1,
			itemsPerPage: 25,
			searchTimeout: null,
			customerSearchTimeout: null,
			creating: null,
			filters: {
				invoice_name: "",
				from_date: "",
				to_date: "",
			},
			customerFilter: null,
			customerOptions: [],
			customerSearchLoading: false,
			showDnDialog: false,
			dnSummary: null,
			showPreviewDialog: false,
			previewPayload: null,
			previewLoading: null,
			headers: [
				{ title: __("Invoice"), key: "name", sortable: false },
				{ title: __("Status"), key: "status", sortable: false, align: "center" },
				{ title: __("Customer"), key: "customer_name", sortable: false },
				{ title: __("Date"), key: "posting_date", sortable: false },
				{ title: __("Grand total"), key: "grand_total", sortable: false, align: "end" },
				{ title: __("Actions"), key: "actions", sortable: false, align: "center", minWidth: "220px" },
			],
			previewHeaders: [
				{ title: __("Item"), key: "item_display", sortable: false },
				{ title: __("Warehouse"), key: "warehouse", sortable: false },
				{ title: __("Qty to deliver"), key: "qty_to_deliver", sortable: false, align: "end" },
				{ title: __("Stock in warehouse"), key: "stock_in_warehouse", sortable: false, align: "end" },
			],
			dnDialogHeaders: [
				{ title: __("Item"), key: "item_display", sortable: false },
				{ title: __("Qty"), key: "qty_display", sortable: false, align: "end" },
				{ title: __("Rate"), key: "rate", sortable: false, align: "end" },
				{ title: __("Amount"), key: "amount", sortable: false, align: "end" },
			],
		};
	},
	watch: {
		posProfile: {
			handler(newVal, oldVal) {
				if (newVal && newVal.name && (!oldVal || oldVal.name !== newVal.name)) {
					this.currentPage = 1;
					this.loadInvoices();
				}
			},
			immediate: true,
		},
	},
	mounted() {
		if (this.posProfile && this.posProfile.name) {
			this.loadInvoices();
		}
		this.onCustomerSearchImmediate("");
	},
	methods: {
		formatDate(value) {
			if (!value) {
				return "—";
			}
			return frappe.datetime.str_to_user ? frappe.datetime.str_to_user(value) : value;
		},
		formatQty(n) {
			const v = parseFloat(n);
			if (Number.isNaN(v)) {
				return "0";
			}
			return String(v);
		},
		formatStockInWarehouse(row) {
			if (!row || !row.is_stock_item) {
				return "—";
			}
			const s = row.stock_in_warehouse;
			if (s === null || s === undefined || Number.isNaN(parseFloat(s))) {
				return "—";
			}
			return this.formatQty(s);
		},
		stockLooksLow(row) {
			if (!row || !row.is_stock_item) {
				return false;
			}
			const need = parseFloat(row.qty_to_deliver) || 0;
			const have = parseFloat(row.stock_in_warehouse);
			if (Number.isNaN(have)) {
				return false;
			}
			return have < need;
		},
		async openDeliveryPreview(invoice) {
			if (!invoice?.name || isOffline()) {
				return;
			}
			this.previewPayload = null;
			this.previewLoading = invoice.name;
			try {
				const r = await frappe.call({
					method: "posawesome.posawesome.api.invoices.get_invoice_delivery_preview",
					args: {
						invoice_name: invoice.name,
						pos_profile: this.posProfile?.name || null,
					},
				});
				this.previewPayload = r.message || null;
				this.showPreviewDialog = true;
			} catch (e) {
				console.error(e);
				this.eventBus.emit("show_message", {
					title: this.parseServerError(e),
					color: "error",
				});
			} finally {
				this.previewLoading = null;
			}
		},
		formatCurrency(amount, currency) {
			const cur = currency || this.posProfile?.currency || "";
			const n = parseFloat(amount) || 0;
			if (typeof frappe?.format === "function") {
				return frappe.format(n, { fieldtype: "Currency", options: cur });
			}
			return `${cur} ${n.toFixed(2)}`;
		},
		getStatusColor(status) {
			const s = (status || "").toLowerCase();
			if (s === "paid") {
				return "success";
			}
			if (s === "draft") {
				return "default";
			}
			if (s === "overdue" || s === "unpaid") {
				return "warning";
			}
			if (s === "cancelled") {
				return "error";
			}
			return "primary";
		},
		getStatusText(status) {
			return status || "—";
		},
		onCustomerSearchDebounced(q) {
			clearTimeout(this.customerSearchTimeout);
			this.customerSearchTimeout = setTimeout(() => {
				this.onCustomerSearchImmediate(q);
			}, 300);
		},
		async onCustomerSearchImmediate(q) {
			this.customerSearchLoading = true;
			try {
				const r = await frappe.call({
					method: "frappe.desk.search.search_link",
					args: {
						doctype: "Customer",
						txt: q == null ? "" : String(q),
						page_length: 20,
					},
				});
				const raw = r.message || [];
				this.customerOptions = raw.map((row) => {
					if (typeof row === "string") {
						return { value: row, description: row };
					}
					return {
						value: row.value,
						description: row.description || row.value,
					};
				});
			} catch (e) {
				console.warn(e);
				this.customerOptions = [];
			} finally {
				this.customerSearchLoading = false;
			}
		},
		onCustomerFilterChange() {
			this.currentPage = 1;
			this.loadInvoices();
		},
		buildListFilters() {
			const f = {
				is_pos: 1,
				for_delivery_note: 1,
				invoice_name: this.filters.invoice_name || undefined,
				from_date: this.filters.from_date || undefined,
				to_date: this.filters.to_date || undefined,
			};
			if (this.customerFilter && this.customerFilter.value) {
				f.customer = this.customerFilter.value;
			}
			return f;
		},
		async loadInvoices() {
			if (!this.posProfile || !this.posProfile.name) {
				return;
			}
			if (isOffline()) {
				this.eventBus.emit("show_message", {
					title: __("Delivery Note requires an online connection"),
					color: "warning",
				});
				return;
			}
			this.loading = true;
			try {
				const response = await frappe.call({
					method: "posawesome.posawesome.api.invoices.get_sales_invoice_list",
					args: {
						page: this.currentPage,
						items_per_page: this.itemsPerPage,
						filters: this.buildListFilters(),
						pos_profile: this.posProfile.name,
					},
				});
				if (response.message) {
					this.invoices = response.message.invoices || [];
				}
			} catch (error) {
				console.error(error);
				this.eventBus.emit("show_message", {
					title: __("Error loading invoices"),
					color: "error",
				});
			} finally {
				this.loading = false;
			}
		},
		debouncedSearch() {
			clearTimeout(this.searchTimeout);
			this.searchTimeout = setTimeout(() => {
				this.currentPage = 1;
				this.loadInvoices();
			}, 400);
		},
		changeItemsPerPage() {
			this.currentPage = 1;
			this.loadInvoices();
		},
		refreshInvoices() {
			this.currentPage = 1;
			this.loadInvoices();
		},
		parseServerError(e) {
			if (e?.message && typeof e.message === "string" && e.message !== "error") {
				return e.message;
			}
			if (e?.exc && typeof e.exc === "string") {
				try {
					const parsed = JSON.parse(e.exc);
					if (Array.isArray(parsed) && parsed[0]) {
						return parsed[0];
					}
				} catch {
					/* ignore */
				}
			}
			return __("Could not create Delivery Note");
		},
		async createDeliveryNote(invoice) {
			if (!invoice || !invoice.name) {
				return;
			}
			if (isOffline()) {
				this.eventBus.emit("show_message", {
					title: __("You are offline"),
					color: "warning",
				});
				return;
			}
			this.creating = invoice.name;
			try {
				const r = await frappe.call({
					method: "posawesome.posawesome.api.invoices.create_delivery_note_from_invoice",
					args: {
						invoice_name: invoice.name,
						pos_profile: this.posProfile?.name || null,
					},
				});
				const summary = r?.message;
				if (summary && summary.name) {
					this.dnSummary = summary;
					this.showDnDialog = true;
					this.eventBus.emit("show_message", {
						title: __("Delivery Note {0} submitted", [summary.name]),
						color: "success",
					});
				}
				await this.loadInvoices();
			} catch (e) {
				console.error(e);
				this.eventBus.emit("show_message", {
					title: this.parseServerError(e),
					color: "error",
				});
			} finally {
				this.creating = null;
			}
		},
	},
};
</script>

<style scoped>
/* Full width like Invoice List: cancel parent .mx-4 from Home.vue, keep horizontal padding */
.delivery-note-from-invoice {
	width: 100%;
	max-width: none;
	box-sizing: border-box;
	margin-left: -16px;
	margin-right: -16px;
	padding-left: 16px;
	padding-right: 16px;
	padding-bottom: 16px;
}

@media (min-width: 960px) {
	.delivery-note-from-invoice {
		margin-left: -24px;
		margin-right: -24px;
		padding-left: 24px;
		padding-right: 24px;
	}
}

.dn-page-header {
	width: 100%;
}

.dn-table-card {
	border-radius: 12px;
	overflow: hidden;
}

.dn-data-table :deep(th) {
	font-weight: 600 !important;
	font-size: 0.75rem;
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.dn-dialog-items {
	border-color: rgba(var(--v-border-color), var(--v-border-opacity)) !important;
}

.dn-totals {
	max-width: 420px;
	margin-left: auto;
}
</style>
