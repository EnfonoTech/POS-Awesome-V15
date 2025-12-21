<template>
	<div class="sales-invoice-list">
		<!-- Header Section -->
		<div class="list-header pa-4">
			<v-row align="center" class="mb-4">
				<v-col cols="12" md="6">
					<h2 class="text-h5 font-weight-bold">{{ __("Invoice List") }}</h2>
				</v-col>
				<v-col cols="12" md="6" class="text-right">
					<v-btn
						color="primary"
						variant="tonal"
						prepend-icon="mdi-refresh"
						@click="refreshInvoices"
						:loading="loading"
						class="mr-2"
					>
						{{ __("Refresh") }}
					</v-btn>
				</v-col>
			</v-row>

			<!-- Filters Section -->
			<v-card class="mb-4" variant="outlined">
				<v-card-text>
					<v-row>
						<v-col cols="12" md="2">
							<v-text-field
								v-model="filters.invoice_name"
								:label="__('Invoice Number')"
								variant="outlined"
								density="compact"
								clearable
								prepend-inner-icon="mdi-magnify"
								@input="debouncedSearch"
							></v-text-field>
						</v-col>
						<v-col cols="12" md="2">
							<v-text-field
								v-model="filters.customer_name"
								:label="__('Customer Name')"
								variant="outlined"
								density="compact"
								clearable
								prepend-inner-icon="mdi-account"
								@input="debouncedSearch"
							></v-text-field>
						</v-col>
						<v-col cols="12" md="2">
							<v-text-field
								v-model="filters.from_date"
								:label="__('From Date')"
								variant="outlined"
								density="compact"
								type="date"
								clearable
								@change="debouncedSearch"
							></v-text-field>
						</v-col>
						<v-col cols="12" md="2">
							<v-text-field
								v-model="filters.to_date"
								:label="__('To Date')"
								variant="outlined"
								density="compact"
								type="date"
								clearable
								@change="debouncedSearch"
							></v-text-field>
						</v-col>
						<v-col cols="12" md="2">
							<v-select
								v-model="filters.status"
								:label="__('Status')"
								variant="outlined"
								density="compact"
								:items="statusOptions"
								clearable
								@update:model-value="debouncedSearch"
							></v-select>
						</v-col>
						<v-col cols="12" md="2">
							<v-select
								v-model="selectedPrintFormat"
								:items="printFormatOptions"
								item-title="title"
								item-value="value"
								:label="__('Print Template')"
								variant="outlined"
								density="compact"
								clearable
								persistent-hint
							></v-select>
						</v-col>
					</v-row>
				</v-card-text>
			</v-card>
		</div>

		<!-- Invoice List -->
		<v-card class="invoice-list-card">
						<v-data-table
				:headers="headers"
				:items="invoices"
				:loading="loading"
				:items-per-page="itemsPerPage"
				class="elevation-1"
				density="comfortable"
				:no-data-text="__('No invoices found')"
				:loading-text="__('Loading invoices...')"
				hide-default-footer
			>
				<!-- Invoice Number Column -->
				<template v-slot:item.name="{ item }">
						<span class="font-weight-medium">{{ item.name }}</span>
				</template>
				<template v-slot:item.status="{ item }">
					<v-chip :color="getStatusColor(item.status)" size="small" class="ma-1" label>
						{{ getStatusText(item.status) }}
					</v-chip>
				</template>
				<!-- Customer Column -->
				<template v-slot:item.customer_name="{ item }">
					<div>
						<div class="font-weight-medium">{{ item.customer_name }}</div>
					</div>
				</template>

				<!-- Date Column -->
				<template v-slot:item.posting_date="{ item }">
					{{ formatDate(item.posting_date) }}
				</template>

				<!-- Amount Column -->
				<template v-slot:item.grand_total="{ item }">
					<div class="text-right" v-html="formatCurrency(item.grand_total, item.currency)"></div>
				</template>

				<!-- Actions Column -->
				<template v-slot:item.actions="{ item }">
					<div class="d-flex align-center">
						<v-tooltip text="View Details">
							<template v-slot:activator="{ props }">
								<v-btn
									v-bind="props"
									icon="mdi-eye"
									size="small"
									variant="text"
									color="primary"
									@click="viewInvoice(item)"
									class="mr-1"
								></v-btn>
							</template>
						</v-tooltip>

						<v-tooltip text="Print Invoice">
							<template v-slot:activator="{ props }">
								<v-btn
									v-bind="props"
									icon="mdi-printer"
									size="small"
									variant="text"
									color="info"
									@click="printInvoice(item)"
									class="mr-1"
								></v-btn>
							</template>
						</v-tooltip>

						<v-menu>
							<template v-slot:activator="{ props }">
								<v-btn
									v-bind="props"
									icon="mdi-dots-vertical"
									size="small"
									variant="text"
									color="default"
								></v-btn>
							</template>
							<v-list density="compact">
								<v-list-item
									prepend-icon="mdi-eye"
									:title="__('Print Preview')"
									@click="printPreview(item)"
								></v-list-item>
								<v-list-item
									prepend-icon="mdi-download"
									:title="__('Download PDF')"
									@click="downloadPDF(item)"
								></v-list-item>
								<v-list-item
									v-if="item.docstatus === 0"
									prepend-icon="mdi-delete"
									:title="__('Delete')"
									@click="deleteInvoice(item)"
									class="text-error"
								></v-list-item>
							</v-list>
						</v-menu>
					</div>
				</template>
			</v-data-table>
			<div class="d-flex justify-end align-center pa-2" style="gap: 8px;">
				<label class="text-sm text-gray-600" style="font-size: 13px;">{{ __("Items per page") }}:</label>
				<div style="width: 90px;">
					<v-select
					v-model="itemsPerPage"
					:items="[10, 20, 25, 50, 100]"
					variant="outlined"
					density="compact"
					hide-details
					@update:model-value="changeItemsPerPage"
					></v-select>
				</div>
			</div>
		</v-card>
		
		<!-- Invoice Details Dialog -->
		<v-dialog v-model="showInvoiceDialog" max-width="800px" scrollable>
			<v-card v-if="selectedInvoice">
				<v-card-title class="d-flex align-center">
					<span>{{ __("Invoice Details") }} - {{ selectedInvoice.name }}</span>
					<v-spacer></v-spacer>
					<v-btn
						icon="mdi-close"
						variant="text"
						density="compact"
						@click="showInvoiceDialog = false"
					></v-btn>
				</v-card-title>
				<v-divider></v-divider>
				<v-card-text>
					<v-row>
						<v-col cols="12" md="6">
							<h4 class="text-h6 mb-2">{{ __("Invoice Information") }}</h4>
							<v-list density="compact">
								<v-list-item>
									<v-list-item-title>{{ __("Invoice Number") }}</v-list-item-title>
									<v-list-item-subtitle>{{ selectedInvoice.name }}</v-list-item-subtitle>
								</v-list-item>
								<v-list-item>
									<v-list-item-title>{{ __("Customer") }}</v-list-item-title>
									<v-list-item-subtitle>{{ selectedInvoice.customer_name }}</v-list-item-subtitle>
								</v-list-item>
								<v-list-item>
									<v-list-item-title>{{ __("Date") }}</v-list-item-title>
									<v-list-item-subtitle>{{ formatDate(selectedInvoice.posting_date) }}</v-list-item-subtitle>
								</v-list-item>
								<v-list-item>
									<v-list-item-title>{{ __("Status") }}</v-list-item-title>
									<v-list-item-subtitle>
										<v-chip
											:color="getStatusColor(selectedInvoice.status)"
											size="small"
										>
											{{ getStatusText(selectedInvoice.status) }}
										</v-chip>
									</v-list-item-subtitle>
								</v-list-item>
							</v-list>
						</v-col>
						<v-col cols="12" md="6">
							<h4 class="text-h6 mb-2">{{ __("Amount Details") }}</h4>
							<v-list density="compact">
								<v-list-item>
									<v-list-item-title>{{ __("Subtotal") }}</v-list-item-title>
									<v-list-item-subtitle>
										<div class="text-right" v-html="formatCurrency(selectedInvoice.net_total, selectedInvoice.currency)"></div>
									</v-list-item-subtitle>
								</v-list-item>
								<v-list-item>
									<v-list-item-title>{{ __("Tax") }}</v-list-item-title>
									<v-list-item-subtitle>
										<div class="text-right" v-html="formatCurrency(selectedInvoice.total_taxes_and_charges, selectedInvoice.currency)"></div>
									</v-list-item-subtitle>
								</v-list-item>
								<v-list-item>
									<v-list-item-title>{{ __("Grand Total") }}</v-list-item-title>
									<v-list-item-subtitle class="font-weight-bold">
										<div class="text-right" v-html="formatCurrency(selectedInvoice.grand_total, selectedInvoice.currency)"></div>
									</v-list-item-subtitle>
								</v-list-item>
							</v-list>
						</v-col>
					</v-row>

					<!-- Items Table -->
					<v-divider class="my-4"></v-divider>
					<h4 class="text-h6 mb-2">{{ __("Items") }}</h4>
					<v-data-table
						:headers="itemHeaders"
						:items="selectedInvoice.items || []"
						density="compact"
						hide-default-footer
						class="elevation-1"
					>
						<template v-slot:item.qty="{ item }">
							<div class="text-center">{{ formatFloat(item.qty) }}</div>
						</template>
						<template v-slot:item.rate="{ item }">
							<div class="text-right">{{ formatCurrency(item.rate, selectedInvoice.currency) }}</div>
						</template>
						<template v-slot:item.amount="{ item }">
							<div class="text-right">{{ formatCurrency(item.amount, selectedInvoice.currency) }}</div>
						</template>
					</v-data-table>
				</v-card-text>
				<v-card-actions>
					<v-spacer></v-spacer>
					<v-btn
						color="primary"
						variant="tonal"
						prepend-icon="mdi-printer"
						@click="printInvoice(selectedInvoice)"
					>
						{{ __("Print") }}
					</v-btn>
					<v-btn
						color="default"
						variant="text"
						@click="showInvoiceDialog = false"
					>
						{{ __("Close") }}
					</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<!-- Print Preview Modal -->
		<v-dialog v-model="showPrintPreview" max-width="90%" scrollable>
			<v-card v-if="previewInvoice">
				<v-card-title class="d-flex align-center">
					<span>{{ __("Print Preview") }} - {{ previewInvoice.name }}</span>
					<v-spacer></v-spacer>
					<v-btn
						icon="mdi-close"
						variant="text"
						density="compact"
						@click="showPrintPreview = false"
					></v-btn>
				</v-card-title>
				<v-divider></v-divider>
				<v-card-text>
					<iframe
						:src="getPrintPreviewUrl(previewInvoice)"
						width="100%"
						height="600px"
						frameborder="0"
						style="border: 1px solid #ddd; border-radius: 4px;"
					></iframe>
				</v-card-text>
				<v-card-actions>
					<v-spacer></v-spacer>
					<v-btn
						color="primary"
						variant="tonal"
						prepend-icon="mdi-printer"
						@click="printFromPreview"
					>
						{{ __("Print") }}
					</v-btn>
					<v-btn
						color="default"
						variant="text"
						@click="showPrintPreview = false"
					>
						{{ __("Close") }}
					</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</div>
</template>

<script>
/* global frappe, __ */
import { printInvoice, downloadInvoicePDF, printPreview } from "../../utils/printUtils.js";

export default {
	name: "SalesInvoiceList",
	props: {
		posProfile: {
			type: Object,
			default: () => ({})
		}
	},
	data() {
		return {
			loading: false,
			invoices: [],
			selectedInvoice: null,
			showInvoiceDialog: false,
			currentPage: 1,
			itemsPerPage: 25,
			hasMore: false,
			searchTimeout: null,
			filters: {
				invoice_name: "",
				customer_name: "",
				from_date: "",
				to_date: "",
				status: "",
			},
			statusOptions: [
				{ title: __("Paid"), value: "Paid" },
				{ title: __("Unpaid"), value: "Unpaid" },
				{ title: __("Overdue"), value: "Overdue" },
				{ title: __("Draft"), value: "Draft" },
				{ title: __("Cancelled"), value: "Cancelled" },
			],
			headers: [
				{ title: __("Invoice No"), key: "name", sortable: true },
				{ title: __("Status"), key: "status", sortable: false, align: "center" },
				{ title: __("Customer"), key: "customer_name", sortable: true },
				{ title: __("Date"), key: "posting_date", sortable: true },
				{ title: __("Amount"), key: "grand_total", sortable: true, align: "end" },
				{ title: __("Actions"), key: "actions", sortable: false, align: "center", width: "140px" },
			],
			itemHeaders: [
				{ title: __("Item"), key: "item_name" },
				{ title: __("Qty"), key: "qty", align: "end" },
				{ title: __("Rate"), key: "rate", align: "end" },
				{ title: __("Amount"), key: "amount", align: "end" },
			],
			showPrintPreview: false,
			previewInvoice: null,
			printFormatOptions: [],
			selectedPrintFormat: null,
			fatehSettings: {},
		};
	},
	async mounted() {
		await this.loadFatehSettings();

		if (this.fatehSettings.default_print_format && !this.selectedPrintFormat) {
			this.selectedPrintFormat = this.fatehSettings.default_print_format;
		}

		await this.loadPrintFormats();
		this.loadInvoices();
	},
	watch: {
		posProfile: {
			handler(newVal, oldVal) {
				if (newVal && newVal.name && (!oldVal || oldVal.name !== newVal.name)) {
					this.currentPage = 1; // Reset to first page
					this.loadInvoices();
					this.selectedPrintFormat =
						this.selectedPrintFormat ||
						this.fatehSettings.default_print_format ||
						newVal.print_format ||
						null;
					this.loadPrintFormats();
				}
			},
			immediate: true
		}
	},
	methods: {
		async loadFatehSettings() {
			try {
				const res = await frappe.call({
					method: "frappe.client.get",
					args: {
						doctype: "Fateh POS Settings",
						name: "Fateh POS Settings",
					},
				});
				this.fatehSettings = res?.message || {};
			} catch (error) {
				console.warn("Unable to load Fateh POS Settings:", error);
				this.fatehSettings = {};
			}
		},
		async loadPrintFormats() {
			try {
				// Determine which doctype templates to show based on POS profile setting
				let docTypeFilter = "Sales Invoice"; // Default to Sales Invoice
				
				if (this.posProfile && this.posProfile.create_pos_invoice_instead_of_sales_invoice) {
					docTypeFilter = "POS Invoice";
				}
				
				const resp = await frappe.call({
					method: "frappe.client.get_list",
					args: {
						doctype: "Print Format",
						fields: ["name", "doc_type"],
						filters: {
							doc_type: docTypeFilter,
							disabled: 0,
						},
						limit: 200,
					},
				});

				const formats = Array.isArray(resp.message) ? resp.message : [];
				this.printFormatOptions = formats.map((fmt) => ({
					title: `${fmt.name}`,
					value: fmt.name,
				}));

				// Preserve user choice; otherwise default to Fateh or POS profile setting
				if (!this.selectedPrintFormat) {
					this.selectedPrintFormat =
						this.fatehSettings.default_print_format || this.posProfile?.print_format || null;
				}
			} catch (error) {
				console.error("Error loading print formats:", error);
				this.eventBus.emit("show_message", {
					title: __("Unable to load print formats"),
					color: "error",
				});
			}
		},
		async loadInvoices() {
			// Don't load if posProfile is not available yet
			if (!this.posProfile || !this.posProfile.name) {
				return;
			}
			
			this.loading = true;
			try {
				const args = {
					page: this.currentPage,
					items_per_page: this.itemsPerPage,
					filters: {
						...this.filters,
						is_pos: 1, // Only show POS invoices
					},
					pos_profile: this.posProfile.name, // Filter by current POS profile
				};
				
				const response = await frappe.call({
					method: "posawesome.posawesome.api.invoices.get_sales_invoice_list",
					args: args,
				});

				if (response.message) {
					this.invoices = response.message.invoices || [];
					this.hasMore = response.message.has_more || false;
				}
			} catch (error) {
				console.error("Error loading invoices:", error);
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
			}, 500);
		},

		handlePageChange(page) {
			this.currentPage = page;
			this.loadInvoices();
		},

		refreshInvoices() {
			this.currentPage = 1;
			this.loadInvoices();
		},

		async viewInvoice(invoice) {
			try {
				// Determine doctype from the invoice data or use POS Invoice as default
				let doctype = invoice.doctype || "POS Invoice";
				
				// Try to fetch the document with the determined doctype
				let resp;
				try {
					resp = await frappe.call({
						method: "frappe.client.get",
						args: {
							doctype: doctype,
							name: invoice.name,
						},
					});
				} catch (error) {
					// If the first attempt fails, try the alternative doctype
					console.log(`Failed to fetch ${invoice.name} as ${doctype}, trying alternative doctype`);
					const alternativeDoctype = doctype === "POS Invoice" ? "Sales Invoice" : "POS Invoice";
					resp = await frappe.call({
						method: "frappe.client.get",
						args: {
							doctype: alternativeDoctype,
							name: invoice.name,
						},
					});
					doctype = alternativeDoctype; // Update doctype for consistency
				}
				
				this.selectedInvoice = resp.message;
				
				// Ensure items have proper numeric values
				if (this.selectedInvoice.items) {
					this.selectedInvoice.items.forEach(item => {
						item.qty = parseFloat(item.qty) || 0;
						item.rate = parseFloat(item.rate) || 0;
						item.amount = parseFloat(item.amount) || 0;
					});
				}
				
				this.showInvoiceDialog = true;
			} catch (err) {
				console.error("Failed to load invoice details:", err);
				this.eventBus.emit("show_message", {
					title: __("Error loading invoice details"),
					color: "error",
				});
			}
		},


		async printInvoice(invoice) {
			try {
				const doctype = invoice.doctype || 'POS Invoice';
				const defaultFormat = doctype === 'POS Invoice' ? 'POS Invoice Print' : 'Sales Invoice Print';
				
				const printOptions = {
					format:
						this.selectedPrintFormat ||
						this.fatehSettings.default_print_format ||
						this.posProfile?.print_format ||
						defaultFormat,
					letter_head: this.posProfile?.letter_head || null,
					silent: this.posProfile?.posa_silent_print || false,
					onSuccess: () => {
						this.eventBus.emit("show_message", {
							title: __("Print job completed"),
							color: "success",
						});
					},
					onError: (error) => {
						console.error("Print error:", error);
						this.eventBus.emit("show_message", {
							title: __("Error printing invoice"),
							color: "error",
						});
					}
				};

				printInvoice(invoice, printOptions);
			} catch (error) {
				console.error("Error printing invoice:", error);
				this.eventBus.emit("show_message", {
					title: __("Error printing invoice"),
					color: "error",
				});
			}
		},

		async downloadPDF(invoice) {
			try {
				const doctype = invoice.doctype || 'POS Invoice';
				const defaultFormat = doctype === 'POS Invoice' ? 'POS Invoice Print' : 'Sales Invoice Print';
				
				const downloadOptions = {
					format:
						this.selectedPrintFormat ||
						this.fatehSettings.default_print_format ||
						this.posProfile?.print_format ||
						defaultFormat,
					letter_head: this.posProfile?.letter_head || null,
				};

				const success = downloadInvoicePDF(invoice, downloadOptions);
				
				if (success) {
					this.eventBus.emit("show_message", {
						title: __("PDF download started"),
						color: "success",
					});
				} else {
					throw new Error("Download failed");
				}
			} catch (error) {
				console.error("Error downloading PDF:", error);
				this.eventBus.emit("show_message", {
					title: __("Error downloading PDF"),
					color: "error",
				});
			}
		},

		printPreview(invoice) {
			this.previewInvoice = invoice;
			this.showPrintPreview = true;
		},

		getPrintPreviewUrl(invoice) {
			const baseUrl = frappe.urllib.get_base_url();
			const doctype = invoice.doctype || 'POS Invoice';
			const defaultFormat = doctype === 'POS Invoice' ? 'POS Invoice Print' : 'Sales Invoice Print';
			
			const params = new URLSearchParams({
				doctype: doctype,
				name: invoice.name,
				format:
					this.selectedPrintFormat ||
					this.fatehSettings.default_print_format ||
					this.posProfile?.print_format ||
					defaultFormat,
				no_letterhead: '0'
			});

			if (this.posProfile?.letter_head) {
				params.append('letter_head', this.posProfile.letter_head);
			}

			return `${baseUrl}/printview?${params.toString()}`;
		},

		printFromPreview() {
			if (this.previewInvoice) {
				this.printInvoice(this.previewInvoice);
				this.showPrintPreview = false;
			}
		},


		async deleteInvoice(invoice) {
			if (!confirm(__("Are you sure you want to delete this invoice?"))) {
				return;
			}

			try {
				const doctype = invoice.doctype || 'POS Invoice';
				
				await frappe.call({
					method: "posawesome.posawesome.api.invoices.delete_invoice",
					args: {
						invoice: invoice.name,
					},
				});

				this.eventBus.emit("show_message", {
					title: __("Invoice deleted successfully"),
					color: "success",
				});

				this.loadInvoices();
			} catch (error) {
				console.error("Error deleting invoice:", error);
				this.eventBus.emit("show_message", {
					title: __("Error deleting invoice"),
					color: "error",
				});
			}
		},

		getStatusColor(status) {
			// status expected like "Unpaid", "Paid", "Overdue", "Draft", "Cancelled"
			if (!status) return "grey";
			const s = String(status).toLowerCase();
			if (s === "paid") return "green";
			if (s === "unpaid") return "orange";
			if (s === "overdue") return "red";
			if (s === "draft") return "orange";
			if (s === "cancelled") return "red";
			// fallback
			return "grey";
			},

			getStatusText(status) {
			if (!status) return __("Unknown");
			return status; // already user-friendly strings from ERPNext
			},


		formatDate(date) {
			if (!date) return "";
			return frappe.datetime.str_to_user(date);
		},

		formatCurrency(amount, currency) {
			if (amount === null || amount === undefined || amount === "") return "0.00";
			const formatted = frappe.format(amount, {
				fieldtype: "Currency",
				currency: currency || "USD",
			});
			// Remove HTML tags and return plain text
			return formatted.replace(/<[^>]*>/g, '');
		},

		formatFloat(value) {
			if (value === null || value === undefined || value === "") return "0.00";
			const formatted = frappe.format(value, {
				fieldtype: "Float",
				precision: 2,
			});
			// Remove HTML tags and return plain text
			return formatted.replace(/<[^>]*>/g, '');
		},
		changeItemsPerPage() {
			this.currentPage = 1;
			this.loadInvoices();
		}
	},
	
};
</script>

<style scoped>
.sales-invoice-list {
	padding: 0;
}

.list-header {
	background-color: var(--surface-secondary);
	border-radius: 8px 8px 0 0;
}

.invoice-list-card {
	border-radius: 0 0 8px 8px;
}

:deep(.v-data-table) {
	border-radius: 0 0 8px 8px;
}

:deep(.v-data-table__wrapper) {
	border-radius: 0 0 8px 8px;
}

/* Responsive adjustments */
@media (max-width: 768px) {
	.list-header .v-col {
		text-align: left !important;
	}
	
	.list-header .v-btn {
		margin-bottom: 8px;
	}
}
</style>
