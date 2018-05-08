import Ember from 'ember';
import Controller from '@ember/controller';

const {
  computed: {
    alias
  }
} = Ember;

export default Controller.extend({
    invoicesController: Ember.inject.controller('invoices'),
    logoURL: alias('invoicesController.printHeader.value.logoURL'),
    facilityName: alias('invoicesController.printHeader.value.facilityName'),
    headerLine1: alias('invoicesController.printHeader.value.headerLine1'),
    headerLine2: alias('invoicesController.printHeader.value.headerLine2'),
    headerLine3: alias('invoicesController.printHeader.value.headerLine3'),
    actions: {
      returnToInvoice() {
        this.transitionTo('invoices.edit', this.get('model'));
    }
  }
});
