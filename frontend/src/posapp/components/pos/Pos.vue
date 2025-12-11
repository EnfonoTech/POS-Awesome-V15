<template>
	<div
		class="pos-main-container dynamic-container"
		:class="rtlClasses"
		:style="[responsiveStyles, rtlStyles]"
	>
		<ClosingDialog></ClosingDialog>
		<Drafts></Drafts>
		<SalesOrders></SalesOrders>
		<Returns></Returns>
		<NewAddress></NewAddress>
		<MpesaPayments></MpesaPayments>
		<Variants></Variants>
		<OpeningDialog v-if="dialog" :dialog="dialog"></OpeningDialog>
		<v-row v-show="!dialog" dense class="ma-0 dynamic-main-row">
			<v-col
				v-show="!payment && !showOffers && !coupons && !hideLeftPanel"
				xl="5"
				lg="5"
				md="5"
				sm="5"
				cols="12"
				class="pos dynamic-col"
			>
				<ItemsSelector></ItemsSelector>
			</v-col>
			<v-col v-show="showOffers && !hideLeftPanel" xl="5" lg="5" md="5" sm="5" cols="12" class="pos dynamic-col">
				<PosOffers></PosOffers>
			</v-col>
			<v-col v-show="coupons && !hideLeftPanel" xl="5" lg="5" md="5" sm="5" cols="12" class="pos dynamic-col">
				<PosCoupons></PosCoupons>
			</v-col>
			<v-col v-show="payment && !hideLeftPanel" xl="5" lg="5" md="5" sm="5" cols="12" class="pos dynamic-col">
				<Payments></Payments>
			</v-col>

			<v-col 
				:xl="hideLeftPanel ? 12 : 7" 
				:lg="hideLeftPanel ? 12 : 7" 
				:md="hideLeftPanel ? 12 : 7" 
				:sm="hideLeftPanel ? 12 : 7" 
				cols="12" 
				class="pos dynamic-col"
				:class="{ 'fullscreen-right': hideLeftPanel }"
			>
				<!-- VERSION: 2.0.3 - Scanner moved to search position -->
				<!-- Version Indicator -->
				<v-chip 
					color="primary" 
					size="small" 
					class="version-indicator-chip"
					style="position: fixed; top: 60px; right: 10px; z-index: 9999; font-weight: bold; font-size: 12px; padding: 4px 8px;"
				>
					v2.0.3
				</v-chip>
				<div class="invoice-wrapper">
				<Invoice></Invoice>
				</div>
			</v-col>
		</v-row>
	</div>
</template>

<script>
import ItemsSelector from "./ItemsSelector.vue";
import Invoice from "./Invoice.vue";
import OpeningDialog from "./OpeningDialog.vue";
import Payments from "./Payments.vue";
import PosOffers from "./PosOffers.vue";
import PosCoupons from "./PosCoupons.vue";
import Drafts from "./Drafts.vue";
import SalesOrders from "./SalesOrders.vue";
import ClosingDialog from "./ClosingDialog.vue";
import NewAddress from "./NewAddress.vue";
import Variants from "./Variants.vue";
import Returns from "./Returns.vue";
import MpesaPayments from "./Mpesa-Payments.vue";
import {
	getOpeningStorage,
	setOpeningStorage,
	clearOpeningStorage,
	initPromise,
	checkDbHealth,
	setTaxTemplate,
} from "../../../offline/index.js";
import { getCurrentInstance } from "vue";
import { usePosShift } from "../../composables/usePosShift.js";
import { useOffers } from "../../composables/useOffers.js";
// Import the cache cleanup function
import { clearExpiredCustomerBalances } from "../../../offline/index.js";
import { useResponsive } from "../../composables/useResponsive.js";
import { useRtl } from "../../composables/useRtl.js";
import { useCustomersStore } from "../../stores/customersStore.js";
import { storeToRefs } from "pinia";

export default {
	setup() {
		const instance = getCurrentInstance();
		const responsive = useResponsive();
		const rtl = useRtl();
		const shift = usePosShift(() => {
			if (instance && instance.proxy) {
				instance.proxy.dialog = true;
			}
		});
		const offers = useOffers();
		return { ...responsive, ...rtl, ...shift, ...offers };
	},
	data: function () {
		return {
			dialog: false,

			payment: false,
			showOffers: false,
			coupons: false,
			itemsLoaded: false,
			customersLoaded: false,
			hideLeftPanel: true, // VERSION 2.0.1 - Default hide left panel
		};
	},

	components: {
		ItemsSelector,
		Invoice,
		OpeningDialog,
		Payments,
		Drafts,
		ClosingDialog,

		Returns,
		PosOffers,
		PosCoupons,
		NewAddress,
		Variants,
		MpesaPayments,
		SalesOrders,
	},

	methods: {
		create_opening_voucher() {
			this.dialog = true;
		},
		get_pos_setting() {
			frappe.db.get_doc("POS Settings", undefined).then((doc) => {
				this.eventBus.emit("set_pos_settings", doc);
			});
		},
		checkLoadingComplete() {
			if (this.itemsLoaded && this.customersLoaded) {
				console.info("Loading completed");
			}
		},
		toggleLeftPanel() {
			this.hideLeftPanel = !this.hideLeftPanel;
		},
	},

	mounted: function () {
		this.$nextTick(function () {
			this.check_opening_entry();
			this.get_pos_setting();
			this.eventBus.on("close_opening_dialog", () => {
				this.dialog = false;
			});
			this.eventBus.on("register_pos_data", (data) => {
				this.pos_profile = data.pos_profile;
				this.get_offers(this.pos_profile.name, this.pos_profile);
				this.pos_opening_shift = data.pos_opening_shift;
				this.eventBus.emit("register_pos_profile", data);
				console.info("LoadPosProfile");
			});
			// When profile is registered directly from composables,
			// ensure offers are fetched as well
			this.eventBus.on("register_pos_profile", (data) => {
				if (data && data.pos_profile) {
					this.get_offers(data.pos_profile.name, data.pos_profile);
				}
			});
			this.eventBus.on("show_offers", (data) => {
				this.showOffers = data === "true";
				this.payment = false;
				this.coupons = false;
			});
			this.eventBus.on("show_coupons", (data) => {
				this.coupons = data === "true";
				this.showOffers = false;
				this.payment = false;
			});
			this.eventBus.on("open_closing_dialog", () => {
				this.get_closing_data();
			});
			this.eventBus.on("submit_closing_pos", (data) => {
				this.submit_closing_pos(data);
			});

			this.eventBus.on("items_loaded", () => {
				this.itemsLoaded = true;
				this.checkLoadingComplete();
			});
			// VERSION 2.0.1 - Listen for toggle item panel event from menu
			this.eventBus.on("toggle-item-panel", () => {
				this.toggleLeftPanel();
			});
			// VERSION 2.0.2 - Listen for pay event to unhide left panel, hide when closed
			this.eventBus.on("show_payment", (data) => {
				const wasPaymentOpen = this.payment;
				this.payment = data === "true";
				this.showOffers = false;
				this.coupons = false;
				// VERSION 2.0.2 - Unhide left panel when pay is clicked
				if (this.payment && this.hideLeftPanel) {
					this.hideLeftPanel = false;
				}
				// VERSION 2.0.2 - Hide left panel when payment is closed/cancelled
				if (wasPaymentOpen && !this.payment) {
					this.hideLeftPanel = true;
					this.$nextTick(() => {
						this.$forceUpdate();
					});
				}
			});
			// VERSION 2.0.2 - Also listen for close_payments event
			this.eventBus.on("close_payments", () => {
				if (this.payment) {
					this.payment = false;
					this.hideLeftPanel = true;
					this.$nextTick(() => {
						this.$forceUpdate();
					});
				} else {
					// Even if payment wasn't open, ensure panel is hidden
					if (!this.hideLeftPanel) {
						this.hideLeftPanel = true;
						this.$nextTick(() => {
							this.$forceUpdate();
						});
					}
				}
			});
			// VERSION 2.0.2 - Listen for hide item panel event (after submit/submit & print/save & clear)
			this.hidePanelHandler = () => {
				// Hide the left panel
				this.hideLeftPanel = true;
				// Also close payment screen if it's open
				if (this.payment) {
					this.payment = false;
				}
				// Force Vue reactivity update
				this.$nextTick(() => {
					this.$forceUpdate();
				});
			};
			this.eventBus.on("hide-item-panel", this.hidePanelHandler);
		});
	},
	beforeUnmount() {
		this.eventBus.off("close_opening_dialog");
		this.eventBus.off("register_pos_data");
		this.eventBus.off("register_pos_profile");
		this.eventBus.off("LoadPosProfile");
		this.eventBus.off("show_offers");
		this.eventBus.off("show_coupons");
		this.eventBus.off("open_closing_dialog");
		this.eventBus.off("submit_closing_pos");
		this.eventBus.off("items_loaded");
		this.eventBus.off("toggle-item-panel");
		this.eventBus.off("close_payments");
		if (this.hidePanelHandler) {
			this.eventBus.off("hide-item-panel", this.hidePanelHandler);
		}
	},
	// In the created() or mounted() lifecycle hook
	created() {
		// Clean up expired customer balance cache on POS load
		clearExpiredCustomerBalances();
		const customersStore = useCustomersStore();
		const { customersLoaded } = storeToRefs(customersStore);
		this.$watch(
			() => customersLoaded.value,
			(value) => {
				if (value) {
					this.customersLoaded = true;
					this.checkLoadingComplete();
				}
			},
			{ immediate: true },
		);
	},
};
</script>

<style scoped>
.dynamic-container {
	/* add space for the navbar with better spacing */
	/*padding-top: calc(25px + var(--dynamic-lg));*/
	/* Navbar height (25px) + larger spacing */
	transition: all 0.3s ease;
}

.dynamic-main-row {
	padding: 0;
	margin: 0;
}

.dynamic-col {
	padding: var(--dynamic-sm);
	transition: padding 0.3s ease;
	margin-top: var(--dynamic-sm);
	/* Add top margin for better separation */
}

@media (max-width: 768px) {
	.dynamic-container {
		padding-top: calc(56px + var(--dynamic-md));
		/* Consistent navbar height + medium spacing */
	}

	.dynamic-col {
		padding: var(--dynamic-xs);
		margin-top: var(--dynamic-xs);
	}
}

.invoice-wrapper {
	position: relative;
}
</style>
