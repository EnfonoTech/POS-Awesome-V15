<template>
	<v-row justify="center">
		<v-dialog v-model="customerDialog" max-width="600px" persistent>
			<v-card>
				<v-card-title class="d-flex align-center">
					<span v-if="customer_id" class="text-h5 text-primary">{{ __("Update Customer") }}</span>
					<span v-else class="text-h5 text-primary">{{ __("Create Customer") }}</span>
					<v-spacer></v-spacer>
					<v-switch
						v-model="hideNonEssential"
						density="compact"
						inset
						hide-details
						color="primary"
						:label="__('Hide Non Essential Fields')"
					></v-switch>
				</v-card-title>
				<v-card-text class="pa-0">
					<v-container>
						<v-row>
							<v-col cols="12">
								<v-text-field
									density="compact"
									color="primary"
									:label="hideNonEssential ? frappe._('Customer Name / mobile number') + ' *' : frappe._('Customer Name') + ' *'"
									hide-details
									class="pos-themed-input"
									v-model="customer_name"
								></v-text-field>
							</v-col>
							<v-col cols="6" v-if="!hideNonEssential">
								<v-text-field
									density="compact"
									color="primary"
									:label="frappe._('Tax ID / VAT ID')"
									class="pos-themed-input"
									hide-details
									v-model="tax_id"
								></v-text-field>
							</v-col>
							<v-col cols="6" v-if="!hideNonEssential">
								<v-text-field
									density="compact"
									color="primary"
									:label="frappe._('Mobile No')"
									class="pos-themed-input"
									hide-details
									v-model="mobile_no"
								></v-text-field>
							</v-col>
							<v-col cols="12" v-if="!hideNonEssential || hasTaxId">
								<v-text-field
									density="compact"
									color="primary"
									:label="__('Address Line 1') + (hasTaxId ? ' *' : '')"
									:error-messages="hasTaxId && !address_line1 ? [__('Address Line 1 is required for ZATCA compliance')] : []"
									class="pos-themed-input"
									v-model="address_line1"
								></v-text-field>
							</v-col>

							<v-col cols="12" sm="6" v-if="!hideNonEssential || hasTaxId">
								<v-text-field
									density="compact"
									color="primary"
									:label="__('Building Number') + (hasTaxId ? ' *' : '')"
									:error-messages="hasTaxId && !custom_building_number ? [__('Building Number is required for ZATCA compliance')] : []"
									class="pos-themed-input"
									v-model="custom_building_number"
								></v-text-field>
							</v-col>

							<v-col cols="12" sm="6" v-if="!hideNonEssential || hasTaxId">
								<v-text-field
									density="compact"
									color="primary"
									:label="__('Area') + (hasTaxId ? ' *' : '')"
									:error-messages="hasTaxId && !custom_area ? [__('Area is required for ZATCA compliance')] : []"
									class="pos-themed-input"
									v-model="custom_area"
								></v-text-field>
							</v-col>

							<v-col cols="12" sm="6" v-if="!hideNonEssential || hasTaxId">
								<v-text-field
									v-model="city"
									variant="outlined"
									density="compact"
									:label="__('City') + (hasTaxId ? ' *' : '')"
									:error-messages="hasTaxId && !city ? [__('City is required for ZATCA compliance')] : []"
									class="pos-themed-input"
								></v-text-field>
							</v-col>

							<v-col cols="12" sm="6" v-if="!hideNonEssential || hasTaxId">
								<v-text-field
									v-model="pincode"
									variant="outlined"
									density="compact"
									:label="__('Postal Code') + (hasTaxId ? ' *' : '')"
									:error-messages="hasTaxId && !pincode ? [__('Postal Code is required for ZATCA compliance')] : []"
									class="pos-themed-input"
								></v-text-field>
							</v-col>

							<v-col cols="12" sm="6" v-if="!hideNonEssential">
								<v-select
									v-model="country"
									:items="countries"
									variant="outlined"
									density="compact"
									:label="__('Country')"
									class="pos-themed-input"
								></v-select>
							</v-col>

							<v-col cols="6" v-if="!hideNonEssential">
								<v-text-field
									density="compact"
									color="primary"
									:label="frappe._('Email Id')"
									class="pos-themed-input"
									hide-details
									v-model="email_id"
								></v-text-field>
							</v-col>
							<v-col cols="6" v-if="!hideNonEssential">
								<v-text-field
									density="compact"
									color="primary"
									:label="frappe._('Referral Code')"
									class="pos-themed-input"
									hide-details
									v-model="referral_code"
								></v-text-field>
							</v-col>
							<v-col cols="6" v-if="!hideNonEssential">
								<v-autocomplete
									clearable
									density="compact"
									auto-select-first
									color="primary"
									:label="frappe._('Customer Group')"
									v-model="group"
									:items="groups"
									class="pos-themed-input"
									:no-data-text="__('Group not found')"
									hide-details
								>
								</v-autocomplete>
							</v-col>
							<v-col cols="6" v-if="!hideNonEssential">
								<v-autocomplete
									clearable
									density="compact"
									auto-select-first
									color="primary"
									:label="frappe._('Territory')"
									v-model="territory"
									:items="territorys"
									class="pos-themed-input"
									:no-data-text="__('Territory not found')"
									hide-details
								>
								</v-autocomplete>
							</v-col>
							<v-col cols="6" v-if="loyalty_program">
								<v-text-field
									v-model="loyalty_program"
									:label="frappe._('Loyalty Program')"
									density="compact"
									readonly
									hide-details
									class="pos-themed-input"
								></v-text-field>
							</v-col>
							<v-col cols="6" v-if="loyalty_points">
								<v-text-field
									v-model="loyalty_points"
									:label="frappe._('Loyalty Points')"
									density="compact"
									readonly
									hide-details
									class="pos-themed-input"
								></v-text-field>
							</v-col>
						</v-row>
					</v-container>
				</v-card-text>
				<v-card-actions class="pa-4">
					<v-spacer></v-spacer>
					<v-btn color="error" theme="dark" @click="confirm_close">{{ __("Close") }}</v-btn>
					<v-btn 
						color="success" 
						size="large"
						class="submit-btn-overlap"
						@click="submit_dialog"
					>
						{{ __("Submit") }}
					</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<!-- Confirmation Dialog -->
		<v-dialog v-model="confirmDialog" max-width="400px">
			<v-card>
				<v-card-title class="text-h5 text-primary">
					{{ __("Confirm Close") }}
				</v-card-title>
				<v-card-text>
					{{ __("Are you sure you want to close? All entered data will be lost.") }}
				</v-card-text>
				<v-card-actions>
					<v-spacer></v-spacer>
					<v-btn color="primary" @click="confirmDialog = false">
						{{ __("Continue Editing") }}
					</v-btn>
					<v-btn color="error" @click="confirmClose">
						{{ __("Yes, Close") }}
					</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</v-row>
</template>

<script>
import { isOffline, saveOfflineCustomer } from "../../../offline/index.js";
import { useCustomersStore } from "../../stores/customersStore.js";

export default {
	data: () => ({
		customerDialog: false,
		confirmDialog: false,
		pos_profile: "",
		customer_id: "",
		customer_name: "",
		tax_id: "",
		mobile_no: "",
		address_line1: "",
		custom_building_number: "",
		custom_area: "",
		city: "",
		pincode: "",
		country: "Pakistan",
		email_id: "",
		referral_code: "",
		group: "",
		groups: [],
		territory: "",
		territorys: [],
		customer_type: "Individual",
		loyalty_points: null,
		loyalty_program: null,
		hideNonEssential: true,
		countries: [
			"Afghanistan",
			"Australia",
			"Bahrain",
			"Bangladesh",
			"Canada",
			"China",
			"Denmark",
			"France",
			"Germany",
			"India",
			"Indonesia",
			"Italy",
			"Japan",
			"Kuwait",
			"Malaysia",
			"Nepal",
			"Netherlands",
			"New Zealand",
			"Norway",
			"Oman",
			"Pakistan",
			"Philippines",
			"Qatar",
			"Saudi Arabia",
			"Singapore",
			"South Korea",
			"Spain",
			"Sri Lanka",
			"Sweden",
			"Switzerland",
			"Syria",
			"Thailand",
			"United Arab Emirates",
			"United Kingdom",
			"United States",
			"Vietnam",
			"Yemen",
		],
	}),
		watch: {
		hideNonEssential(val) {
			if (typeof localStorage !== "undefined") {
				localStorage.setItem("posawesome_hide_non_essential_fields", JSON.stringify(val));
			}
			// When hide non essential is enabled, sync customer_name and mobile_no
			if (val) {
				// If customer_name has value and looks like a phone number, set mobile_no
				if (this.customer_name && !this.mobile_no && this.isValidPhoneNumber(this.customer_name)) {
					this.mobile_no = this.customer_name;
				}
				// If mobile_no has value but customer_name doesn't, set customer_name to mobile_no
				if (this.mobile_no && !this.customer_name) {
					this.customer_name = this.mobile_no;
				}
			}
		},
		customer_name(newVal) {
			// When hide non essential is enabled, only set mobile_no if it's a valid phone number
			if (this.hideNonEssential && newVal) {
				if (this.isValidPhoneNumber(newVal)) {
					this.mobile_no = newVal;
				} else {
					// If it's not a valid phone number, clear mobile_no to avoid validation errors
					this.mobile_no = "";
				}
			}
		},
		tax_id(newVal) {
			// Set customer_type to "Company" if tax_id is present
			if (newVal && newVal.trim()) {
				this.customer_type = "Company";
			} else {
				this.customer_type = "Individual";
			}
		},
	},
	computed: {
		hasTaxId() {
			return !!(this.tax_id && this.tax_id.trim());
		},
	},
	methods: {
		// Check if a value looks like a valid phone number
		isValidPhoneNumber(value) {
			if (!value || typeof value !== 'string') return false;
			// Remove common phone number characters (spaces, dashes, parentheses, plus)
			const cleaned = value.replace(/[\s\-\(\)\+]/g, '');
			// Check if it contains mostly digits and has reasonable length (at least 7 digits, max 15)
			const digitCount = (cleaned.match(/\d/g) || []).length;
			// Phone numbers typically have 7-15 digits
			// Also check that non-digit characters are minimal (only allowed phone chars)
			return digitCount >= 7 && digitCount <= 15 && /^[\d\s\-\(\)\+]+$/.test(value);
		},
		confirm_close() {
			// Check if any data has been entered
			if (
				this.customer_name ||
				this.tax_id ||
				this.mobile_no ||
				this.address_line1 ||
				this.email_id ||
				this.referral_code
			) {
				this.confirmDialog = true;
			} else {
				// If no data entered, just close
				this.close_dialog();
			}
		},
		confirmClose() {
			this.confirmDialog = false;
			this.close_dialog();
		},
		close_dialog() {
			this.customerDialog = false;
			this.clear_customer();
		},
		clear_customer() {
			this.customer_name = "";
			this.tax_id = "";
			this.mobile_no = "";
			this.address_line1 = "";
			this.custom_building_number = "";
			this.custom_area = "";
			this.city = "";
			this.pincode = "";
			this.country = (this.pos_profile && this.pos_profile.posa_default_country) || "Pakistan";
			this.email_id = "";
			this.referral_code = "";
			this.group = frappe.defaults.get_user_default("Customer Group");
			this.territory = frappe.defaults.get_user_default("Territory");
			this.customer_id = "";
			this.customer_type = "Individual";
			this.loyalty_points = null;
			this.loyalty_program = null;
		},
		getCustomerGroups() {
			if (this.groups.length > 0) return;
			const vm = this;
			frappe.db
				.get_list("Customer Group", {
					fields: ["name"],
					filters: { is_group: 0 },
					limit: 1000,
					order_by: "name",
				})
				.then((data) => {
					if (data.length > 0) {
						data.forEach((el) => {
							vm.groups.push(el.name);
						});
					}
				});
		},
		getCustomerTerritorys() {
			if (this.territorys.length > 0) return;
			const vm = this;
			frappe.db
				.get_list("Territory", {
					fields: ["name"],
					filters: { is_group: 0 },
					limit: 5000,
					order_by: "name",
				})
				.then((data) => {
					if (data.length > 0) {
						data.forEach((el) => {
							vm.territorys.push(el.name);
						});
					}
				});
		},
		async submit_dialog() {
			const vm = this;
			// When hide non essential is enabled, only set mobile_no if customer_name is a valid phone number
			if (this.hideNonEssential) {
				// If customer_name is set and looks like a phone number, use it for mobile_no
				if (this.customer_name && this.isValidPhoneNumber(this.customer_name)) {
					this.mobile_no = this.customer_name;
				} else if (this.customer_name && !this.isValidPhoneNumber(this.customer_name)) {
					// If customer_name is not a valid phone number, clear mobile_no to avoid validation errors
					this.mobile_no = "";
				}
				// If mobile_no is set but customer_name is not, use mobile_no for customer_name
				if (this.mobile_no && !this.customer_name) {
					this.customer_name = this.mobile_no;
				}
			}
			
			if (!this.customer_name) {
				this.eventBus.emit("show_message", {
					title: __("Customer Name is required"),
					color: "error",
				});
				return;
			}

			// ZATCA validation: If tax_id is present, validate required address fields
			if (this.hasTaxId) {
				const missingFields = [];
				if (!this.address_line1 || !this.address_line1.trim()) {
					missingFields.push(__("Address Line 1"));
				}
				if (!this.custom_building_number || !this.custom_building_number.trim()) {
					missingFields.push(__("Building Number"));
				}
				if (!this.custom_area || !this.custom_area.trim()) {
					missingFields.push(__("Area"));
				}
				if (!this.city || !this.city.trim()) {
					missingFields.push(__("City"));
				}
				if (!this.pincode || !this.pincode.trim()) {
					missingFields.push(__("Postal Code"));
				}

				if (missingFields.length > 0) {
					this.eventBus.emit("show_message", {
						title: __("For ZATCA compliance, the following fields are required when Tax ID / VAT ID is provided: {0}", 
							missingFields.join(", ")),
						color: "error",
					});
					return;
				}
			}

			// Use defaults if not set (for both hideNonEssential true and false)
			if (!this.group) {
				this.group = frappe.defaults.get_user_default("Customer Group");
			}
			if (!this.territory) {
				this.territory = frappe.defaults.get_user_default("Territory");
			}

			// Set customer_type to "Company" if tax_id is present
			if (this.hasTaxId) {
				this.customer_type = "Company";
			}

			// Create args object to use in callback
			const args = {
				customer_id: this.customer_id,
				customer_name: this.customer_name,
				tax_id: this.tax_id,
				mobile_no: this.mobile_no,
				address_line1: this.address_line1,
				custom_building_number: this.custom_building_number,
				custom_area: this.custom_area,
				city: this.city,
				pincode: this.pincode,
				country: this.country,
				email_id: this.email_id,
				referral_code: this.referral_code,
				customer_group: this.group,
				territory: this.territory,
				customer_type: this.customer_type,
			};
			const apiArgs = {
				...args,
				company: vm.pos_profile.company,
				pos_profile_doc: JSON.stringify(vm.pos_profile),
				method: this.customer_id ? "update" : "create",
			};

			const customersStore = useCustomersStore();

			if (isOffline()) {
				saveOfflineCustomer({ args: apiArgs });
				vm.eventBus.emit("show_message", { title: __("Customer saved offline"), color: "warning" });
				args.name = this.customer_name;
				await customersStore.addOrUpdateCustomer({
					name: args.name,
					customer_name: args.customer_name,
					mobile_no: args.mobile_no,
					email_id: args.email_id,
					tax_id: args.tax_id,
					primary_address: args.address_line1,
				});
				vm.close_dialog();
				return;
			}

			frappe.call({
				method: "posawesome.posawesome.api.customers.create_customer",
				args: apiArgs,
				callback: async (r) => {
					if (!r.exc && r.message && r.message.name) {
						let text = __("Customer created successfully.");
						if (vm.customer_id) {
							text = __("Customer updated successfully.");
						}
						vm.eventBus.emit("show_message", {
							title: text,
							color: "success",
						});
						args.name = r.message.name;
						frappe.utils.play_sound("submit");
						await customersStore.addOrUpdateCustomer({
							name: args.name,
							customer_name: args.customer_name,
							mobile_no: args.mobile_no,
							email_id: args.email_id,
							tax_id: args.tax_id,
							primary_address: args.address_line1,
						});
						vm.close_dialog();
					} else {
						frappe.utils.play_sound("error");
						// Handle error messages from backend
						let errorMessage = __("Customer creation failed.");
						if (r.exc) {
							// Try to extract error message from exception
							try {
								const excData = JSON.parse(r.exc);
								if (excData.message) {
									errorMessage = excData.message;
								} else if (excData.exc) {
									// Check if exc contains the error message
									if (typeof excData.exc === "string") {
										if (excData.exc.includes("already exists") || excData.exc.includes("Customer already exists")) {
											errorMessage = __("Customer already exists with this name.");
										} else {
											errorMessage = excData.exc;
										}
									}
								}
							} catch (e) {
								// If parsing fails, check if r.exc is a string
								if (typeof r.exc === "string") {
									if (r.exc.includes("already exists") || r.exc.includes("Customer already exists")) {
										errorMessage = __("Customer already exists with this name.");
									} else {
										// Try to extract message from the exception string
										const match = r.exc.match(/message[:\s]+([^\\n]+)/i);
										if (match && match[1]) {
											errorMessage = match[1].trim();
										} else {
											errorMessage = r.exc;
										}
									}
								}
							}
						}
						vm.eventBus.emit("show_message", {
							title: errorMessage,
							color: "error",
						});
					}
				},
			});
		},
	},
	created: function () {
		if (typeof localStorage !== "undefined") {
			const saved = localStorage.getItem("posawesome_hide_non_essential_fields");
			if (saved !== null) {
				this.hideNonEssential = JSON.parse(saved);
			} else {
				// Default to true if not saved in localStorage
				this.hideNonEssential = true;
				localStorage.setItem("posawesome_hide_non_essential_fields", JSON.stringify(true));
			}
		} else {
			// Default to true if localStorage is not available
			this.hideNonEssential = true;
		}
		this.eventBus.on("open_update_customer", (data) => {
			this.customerDialog = true;

			if (data) {
				this.customer_name = data.customer_name;
				this.customer_id = data.name;
				this.address_line1 = data.address_line1 || "";
				this.custom_building_number = data.custom_building_number || "";
				this.custom_area = data.custom_area || "";
				this.city = data.city || "";
				this.pincode = data.pincode || "";
				this.country =
					data.country || (this.pos_profile && this.pos_profile.posa_default_country) || "Pakistan";
				this.tax_id = data.tax_id;
				this.mobile_no = data.mobile_no;
				this.email_id = data.email_id;
				this.referral_code = data.referral_code;
				// Set customer group - use default_customer_group if provided, otherwise use existing customer_group
				this.group = data.default_customer_group || data.customer_group;
				this.territory = data.territory;
				this.loyalty_points = data.loyalty_points;
				this.loyalty_program = data.loyalty_program;
				// Set customer_type based on tax_id
				if (data.tax_id) {
					this.customer_type = "Company";
				} else {
					this.customer_type = data.customer_type || "Individual";
				}
				
				// When hide non essential is enabled and customer_name is empty, use mobile_no if it exists
				if (this.hideNonEssential && !this.customer_name && this.mobile_no) {
					this.customer_name = this.mobile_no;
				}
				// If customer_name is set but not a valid phone number, clear mobile_no to avoid validation errors
				if (this.hideNonEssential && this.customer_name && !this.isValidPhoneNumber(this.customer_name)) {
					this.mobile_no = "";
				}
			} else {
				this.country = (this.pos_profile && this.pos_profile.posa_default_country) || "Pakistan";
				// If default_customer_group is provided in data, set it and use defaults for other fields
				if (data && data.default_customer_group) {
					this.group = data.default_customer_group;
					// Set territory from user defaults (same as normal new customer)
					this.territory = frappe.defaults.get_user_default("Territory");
				}
			}
		});
		this.eventBus.on("register_pos_profile", (data) => {
			this.pos_profile = data.pos_profile;
			this.country = (this.pos_profile && this.pos_profile.posa_default_country) || "Pakistan";
		});
		this.eventBus.on("payments_register_pos_profile", (data) => {
			this.pos_profile = data.pos_profile;
			this.country = (this.pos_profile && this.pos_profile.posa_default_country) || "Pakistan";
		});
		this.getCustomerGroups();
		this.getCustomerTerritorys();
		// set default values for customer group and territory from user defaults
		this.group = frappe.defaults.get_user_default("Customer Group");
		this.territory = frappe.defaults.get_user_default("Territory");
	},
};
</script>

<style scoped>
.submit-btn-overlap {
	position: relative;
	z-index: 10;
	transform: scale(1.05);
	margin-left: 16px;
	font-weight: 600;
	letter-spacing: 0.5px;
	min-width: 110px;
	height: 44px;
	background-color: #4caf50 !important;
	color: #ffffff !important;
	text-transform: uppercase;
}

.submit-btn-overlap :deep(.v-btn__content) {
	color: #ffffff !important;
	font-weight: 600;
}

.submit-btn-overlap:hover {
	transform: scale(1.08);
	background-color: #45a049 !important;
}

.submit-btn-overlap:active {
	transform: scale(1.02);
	background-color: #3d8b40 !important;
}
</style>
