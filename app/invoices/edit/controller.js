import AbstractEditController from 'hospitalrun/controllers/abstract-edit-controller';
import Ember from 'ember';
import moment from 'moment';
import NumberFormat from 'hospitalrun/mixins/number-format';
import PatientSubmodule from 'hospitalrun/mixins/patient-submodule';
import PublishStatuses from 'hospitalrun/mixins/publish-statuses';
import SelectValues from 'hospitalrun/utils/select-values';
import uuid from 'npm:uuid';
import config from 'hospitalrun/config/environment';

export default AbstractEditController.extend(NumberFormat, PatientSubmodule, PublishStatuses, {
  invoiceController: Ember.inject.controller('invoices'),
  expenseAccountList: Ember.computed.alias('invoiceController.expenseAccountList.value'),
  patientList: Ember.computed.alias('invoiceController.patientList'),
  pharmacyCharges: [],
  pricingProfiles: Ember.computed.map('invoiceController.pricingProfiles', SelectValues.selectObjectMap),
  supplyCharges: [],
  updateCapability: 'add_invoice',
  wardCharges: [],
  claimItems: [],
  cardData: {},
  copayAmount: 0,

  additionalButtons: function() {
    let buttons = [];
    let isValid = this.get('model.isValid');
    let status = this.get('model.status');
    if (isValid && status === 'Draft') {
      buttons.push({
        class: 'btn btn-default default',
        buttonAction: 'finalizeInvoice',
        buttonIcon: 'glyphicon glyphicon-ok',
        buttonText: 'Invoice Ready'
      });
    }
    buttons.push({
      class: 'btn btn-default neutral',
      buttonAction: 'printInvoice',
      buttonIcon: 'glyphicon glyphicon-print',
      buttonText: 'Print'
    });
    return buttons;

  }.property('model.isValid', 'model.status'),

  canAddCharge: function() {
    return this.currentUserCan('add_charge');
  }.property(),

  _finishUpdate(message, title) {
    this.send('closeModal');
    this.displayAlert(title, message);
  },

  canAddPayment: function() {
    return this.currentUserCan('add_payment');
  }.property(),

  pharmacyExpenseAccount: function() {
    let expenseAccountList = this.get('expenseAccountList');
    if (!Ember.isEmpty(expenseAccountList)) {
      let account = expenseAccountList.find(function(value) {
        if (value.toLowerCase().indexOf('pharmacy') > -1) {
          return true;
        }
      });
      return account;
    }
  }.property('expenseAccountList.value'),

  currentPatient: function() {
    let type = this.get('model.paymentType');
    if (type === 'Deposit') {
      return this.get('model.patient');
    } else {
      return this.get('model.invoice.patient');
    }
  }.property('model.patient', 'model.paymentType', 'model.invoice.patient'),

  actions: {
    readCard() {
      let apiPath = `${config.smartAPI}${this.get('model.patient.friendlyId')}`;
      if (Object.keys(this.cardData).length == 0) {
        $.ajax({
          url: apiPath,
          dataType: 'json',
          success: (response)=>{
            if (response == 0) {
              let message = 'Click forward on Smart to send card information';
              this.displayAlert('Read card', message);
            } else if (response == 2) {
              let message = 'There\'s an invoice been processed for the same patient or claim has already been sent to Smart.';
              this.displayAlert('Read card', message);
            } else if (response == 3) {
              let message = 'Invoice claim was rejected.';
              this.displayAlert('Read card', message);
            } else if (response == 4) {
              let message = 'The invoice has been processed. Finialize and print.';
              this.displayAlert('Read card', message);
            } else {
              this.cardData = response;
              this.processCard(this.cardData);
            }
          }
        });
      } else {
        let message = 'Card has already been read. Click Post to Smart or refresh page.';
        this.displayAlert('Read Card', message);
      }
    },

    sendClaim() {
      if (Object.keys(this.cardData).length == 0) {
        let message = 'Read card first';
        this.displayAlert('Post Status', message);
      } else {
        let hospitalClaim = { 'claim': [] };
        let totalServices = 0;
        let grossAmount = 0;
        let diagnoses = [];
        this.get('model.visit').get('diagnoses').forEach((diagnose)=>{
          let diag = {
            diagnosis: diagnose.get('diagnosis')
          };
          diagnoses.pushObject(diag);
        });
        this.get('model.lineItemsByCategory').forEach((category)=>{
          grossAmount = category.amountOwed;
          category.items.forEach((department)=>{
            department.get('details').forEach((item)=>{
              totalServices += 1;
              let service = this.addService(item, totalServices);
              this.get('claimItems').push(service);
            });
          });
          this.get('claimItems').push(this.addCopayService(totalServices));
          totalServices += 1;
        });
        hospitalClaim.claim.push({ 'Claim_Header': this.setClaimHeader(totalServices, grossAmount, diagnoses) });
        hospitalClaim.claim.push({ 'Member': this.setMemberInfo() });
        hospitalClaim.claim.push({ 'Patient': this.parsePatientInfo(this.get('model.patient')) });
        hospitalClaim.claim.push({ 'Claim_Data': this.setClaimData() });
        this.postToSmart(hospitalClaim);
      }
    },

    getClaimStatus() {
      let apiPath = `${config.smartAPI}${this.get('model.patient.friendlyId')}`;
      $.ajax({
        url: apiPath,
        dataType: 'json',
        success: (response)=>{
          if (response == 0) {
            let message = 'Click forward on Smart to send card information';
            this.displayAlert('Read card', message);
          } else if (response == 2) {
            let message = 'There\'s an invoice been processed for the same patient or claim has already been sent to Smart.';
            this.displayAlert('Read card', message);
          } else if (response == 3) {
            let message = 'Invoice claim was rejected.';
            this.displayAlert('Read card', message);
          } else {
            let message = 'The invoice has been processed. Finialize and print.';
            this.displayAlert('Read card', message);
          }
        }
      });
    },

    addItemCharge(lineItem) {
      let details = lineItem.get('details');
      let detail = this.store.createRecord('line-item-detail', {
        id: uuid.v4()
      });
      details.addObject(detail);
    },

    addLineItem(lineItem) {
      let lineItems = this.get('model.lineItems');
      lineItems.addObject(lineItem);
      this.send('update', true);
      this.send('closeModal');
    },

    deleteCharge(deleteInfo) {
      this._deleteObject(deleteInfo.itemToDelete, deleteInfo.deleteFrom);
    },

    deleteLineItem(deleteInfo) {
      this._deleteObject(deleteInfo.itemToDelete, this.get('model.lineItems'));
    },

    finalizeInvoice() {
      let currentInvoice = this.get('model');
      let invoicePayments = currentInvoice.get('payments');
      let paymentsToSave = [];
      currentInvoice.get('patient.payments').then(function(patientPayments) {
        patientPayments.forEach(function(payment) {
          let invoice = payment.get('invoice');
          if (Ember.isEmpty(invoice)) {
            payment.set('invoice', currentInvoice);
            paymentsToSave.push(payment.save());
            invoicePayments.addObject(payment);
          }
        }.bind(this));
        Ember.RSVP.all(paymentsToSave).then(function() {
          this.set('model.status', 'Billed');
          this.send('update');
        }.bind(this));
      }.bind(this));
    },

    printInvoice() {
      this.transitionToRoute('print.invoice', this.get('model'));
    },

    removePayment(removeInfo) {
      let payments = this.get('model.payments');
      let payment = removeInfo.itemToRemove;
      payment.set('invoice');
      payments.removeObject(removeInfo.itemToRemove);
      this.send('update', true);
      this.send('closeModal');
    },

    showAddLineItem() {
      let newLineItem = this.store.createRecord('billing-line-item', {
        id: uuid.v4()
      });
      this.send('openModal', 'invoices.add-line-item', newLineItem);
    },

    showDeleteItem(itemToDelete, deleteFrom) {
      this.showDeleteModal(itemToDelete, Ember.Object.create({
        confirmAction: 'deleteCharge',
        deleteFrom,
        title: 'Delete Charge'
      }));
    },

    showDeleteLineItem(item) {
      this.showDeleteModal(item, Ember.Object.create({
        confirmAction: 'deleteLineItem',
        title: 'Delete Line Item'
      }));
    },

    showDeleteModal(item, options) {
      options = Ember.merge(options, Ember.Object.create({
        message: `Are you sure you want to delete ${item.get('name')}?`,
        itemToDelete: item,
        updateButtonAction: 'confirm',
        updateButtonText: this.get('i18n').t('buttons.ok')
      }));
      this.send('openModal', 'dialog', options);
    },

    showRemovePayment(payment) {
      let message = 'Are you sure you want to remove this payment from this invoice?';
      let model = Ember.Object.create({
        itemToRemove: payment
      });
      let title = 'Remove Payment';
      this.displayConfirm(title, message, 'removePayment', model);
    },

    toggleDetails(item) {
      item.toggleProperty('showDetails');
    }
  },

  addService(item, number) {
    let date = this.getCurrentDateTime();
    return { 'service': {
      'Number': number,
      'Invoice_Number': this.get('model.id'),
      'Global_Invoice': this.get('model.id'),
      'Start_Date': date.date,
      'Start_Time': date.time,
      'Provider': {
        'Role': 'SP',
        'Practice_Number': 'SKSP_3355'
      },
      'Diagnosis': {
        'Stage': 'P',
        'Code_Type': 'ICD10',
        'Code': 'UNKN'
      },
      'Encounter_Type': item.get('department'),
      'Code_Type': 'Internal',
      'Code': 'UNKN',
      'Code_Description': item.get('name'),
      'Quantity': item.get('quantity'),
      'Total_Amount': `${item.get('price') * item.get('quantity')}`,
      'Reason': ' '
    } };
  },

  addRecord(amount) {
    let invoice = this.get('model');
    let patient = invoice.get('patient');
    let benefits = this.cardData.AdmissionInformation.Benefits.Benefit.Amount.text;
    let payment = this.store.createRecord('payment', {
      invoice,
      paymentType: 'Payment',
      datePaid: new Date()
    });
    payment.set('amount', amount);
    patient.get('payments').then(function(payments) {
      payments.pushObject(payment);
      patient.save().then(function() {
        invoice.addPayment(payment);
        payment.save();
        invoice.save().then(function() {
          let message = `Card benefits = ${benefits}. Added ${payment.get('amount')} to invoice ${invoice.get('id')}. Copay amount = ${this.copayAmount}`;
          this._finishUpdate(message, 'Card Payment Added');
        }.bind(this));
      }.bind(this));
    }.bind(this));
  },

  parsePatientInfo(invoice) {
    let patient  = {
      'Dependant': 'Y',
      'First_Name': invoice.get('firstName'),
      'Middle_Name': invoice.get('middleName'),
      'Surname': invoice.get('lastName'),
      'Date_Of_Birth': ' ',
      'Gender': invoice.get('sex')
    };
    return patient;
  },

  setClaimData() {
    let claim = [{ 'Discharge_Notes': 'Diagn' }];
    claim.push(this.claimItems);
    return claim;
  },

  processCard(card) {
    let benefits = card.AdmissionInformation.Benefits.Benefit.Amount.text;
    card.AdmissionInformation.PaymentModifiers.PaymentModifier.forEach((modifier)=>{
      if (modifier.Type.text == 0) {
        this.copayAmount = parseFloat(modifier.Amount_Required.text);
      }
    });
    let totalAmount = 0;
    this.get('model.lineItemsByCategory').forEach((category)=>{
      totalAmount += parseFloat(category.total);
      if (totalAmount <= this.copayAmount) {
        totalAmount = parseFloat(category.total);
      } else {
        totalAmount = parseFloat(category.total) - this.copayAmount;
      }
      if (totalAmount <= benefits) {
        let message = 'Can be fully settled, add payment';
        this.displayAlert('Card Status', message);
        this.addRecord(totalAmount);
      } else {
        let balance = this._numberFormat(totalAmount - benefits);
        let message = `${'Patient needs to pay '} ${balance}`;
        this.displayAlert('Card Status', message);
        this.addRecord(benefits);
      }
    });
  },

  postToSmart(hospitalClaim) {
    let postUrl = `${config.smartAPI}${this.get('model.patient.friendlyId')}`;
    $.ajax({
      url: postUrl,
      type: 'put',
      cotentType: 'application/json',
      dataType: 'json',
      data: {
        'claim': JSON.stringify(hospitalClaim)
      },
      success: (response)=>{
        console.log('Post response,', response);
        if (response.flag == 2) {
          let message = 'Claim has already been posted. Click retrieve on Smart.';
          this.displayAlert('Post Status', message);
        } else if (response.flag == 3) {
          let message = `Error when posting to smart: ${response.error}`;
          this.displayAlert('Post Status', message);
          this.get('model.patients').get('payments').forEach((payment)=>{
            this.removePayment(payment);
          });
        } else {
          let message = 'Posted to Smart successfully.Go ahead and print the invoice.';
          this.displayAlert('Post Status', message);
        }
      }
    });
  },

  processModifiers() {
    let modifierObject = this.cardData.AdmissionInformation.PaymentModifiers.PaymentModifier;
    console.log(JSON.stringify(modifierObject));
    let modifier1 = {};
    let modifier2 = {};
    modifierObject.forEach((modifier)=>{
      if (modifier.Type.text == 0) {
        modifier1 = {
          'Type': modifier.Type.text,
          'Amount_Required': modifier.Amount_Required.text,
          'Receipt': ' '
        };
      } else {
        modifier2 = {
          'Type': modifier.Type.text,
          'NHIF_Member_Nr': modifier.NHIF_Member_Nr.text,
          'NHIF_Contributor_Nr': ' ',
          'NHIF_Employer_Code': ' ',
          'NHIF_Site_Nr': ' ',
          'NHIF_Patient_Relation': ' ',
          'Diagnosis_Code': ' ',
          'Admit_Date': ' ',
          'Discharge_Date': ' ',
          'Days_Used': ' ',
          'Amount': ' '
        };
      }
    });
    return [{ 'PaymentModifier': modifier1 }, { 'PaymentModifier': modifier2 }];
  },

  setClaimHeader(totalServices, grossAmount) {
    let provider = {
      'Role': 'SP',
      'Country_Code': 'KEN',
      'Group_Practice_Number': 'SKSP_3355',
      'Group_Practice_Name': 'Betacare Ngara Clinic'
    };
    let authorization = {
      'Pre_Authorization_Number': 0,
      'Pre_Authorization_Amount': 0
    };
    let date = this.getCurrentDateTime();
    let header = {
      'Invoice_Number': this.get('model.id'),
      'Claim_Date': date.date,
      'Claim_Time': date.time,
      'Gross_Amount': grossAmount,
      'Total_Services': totalServices,
      'Pool_Number': parseFloat(this.cardData.AdmissionInformation.Benefits.Benefit.Nr.text),
      'Provider': provider,
      'Authorization': authorization,
      'PaymentModifiers': this.processModifiers()
    };
    return header;
  },

  setMemberInfo() {
    let forwardedCardData = this.cardData.AdmissionInformation;
    let member = {
      'Membership_Number': forwardedCardData.B1.medicalaid_number.text,
      'Scheme_Code': forwardedCardData.B1.medicalaid_code.text,
      'Scheme_Plan': forwardedCardData.B1.medicalaid_plan.text,
      'card_serialnumber': forwardedCardData.A1.card_serialnumber.text
    };
    return member;
  },

  getCurrentDateTime() {
    let months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
    let date = new Date();
    let month = months[date.getMonth()];
    let day = 0;
    let hours = 0;
    let minutes = 0;
    let seconds = 0;
    if (date.getDate() < 10) {
      day = months[date.getDate()];
    } else {
      day = date.getDate();
    }
    if (date.getHours() < 10) {
      hours = months[date.getHours()];
    } else {
      hours = date.getHours();
    }
    if (date.getMinutes() < 10) {
      minutes = months[date.getMinutes()];
    } else {
      minutes = date.getMinutes();
    }
    if (date.getSeconds() < 10) {
      seconds = months[date.getSeconds()];
    } else {
      seconds = date.getSeconds();
    }
    return { 'date': `${date.getFullYear()}-${month}-${day}`, 'time': `${hours}:${minutes}:${seconds}` };
  },

  addCopayService(totalServices) {
    let date = this.getCurrentDateTime();
    let number = totalServices + 1;
    return { 'service': {
      'Number': number,
      'Invoice_Number': this.get('model.id'),
      'Global_Invoice': this.get('model.id'),
      'Start_Date': date.date,
      'Start_Time': date.time,
      'Provider': {
        'Role': 'SP',
        'Practice_Number': 'SKSP_3355'
      },
      'Diagnosis': {
        'Stage': 'P',
        'Code_Type': 'ICD10',
        'Code': 'UNKN'
      },
      'Encounter_Type': 'COPAY',
      'Code_Type': 'Internal',
      'Code': 'UNKN',
      'Code_Description': 'Copay',
      'Quantity': 1,
      'Total_Amount': `-${this.copayAmount}`,
      'Reason': ' '
    } };
  },

  changePaymentProfile: function() {
    let patient = this.get('model.patient');
    let paymentProfile = this.get('model.paymentProfile');
    if (!Ember.isEmpty(patient) && Ember.isEmpty(paymentProfile)) {
      this.set('model.paymentProfile', patient.get('paymentProfile'));
    }
  }.observes('model.patient'),

  paymentProfileChanged: function() {
    let discountPercentage = this._getValidNumber(this.get('model.paymentProfile.discountPercentage'));
    let originalPaymentProfileId = this.get('model.originalPaymentProfileId');
    let profileId = this.get('model.paymentProfile.id');
    if (profileId !== originalPaymentProfileId) {
      let lineItems = this.get('model.lineItems');
      lineItems.forEach(function(lineItem) {
        let details = lineItem.get('details');
        let lineDiscount = 0;
        details.forEach(function(detail) {
          let pricingOverrides = detail.get('pricingItem.pricingOverrides');
          if (!Ember.isEmpty(pricingOverrides)) {
            let pricingOverride = pricingOverrides.findBy('profile.id', profileId);
            if (!Ember.isEmpty(pricingOverride)) {
              Ember.set(detail, 'price', pricingOverride.get('price'));
            }
          }
        }.bind(this));
        if (discountPercentage > 0) {
          let lineTotal = lineItem.get('total');
          lineDiscount = this._numberFormat((discountPercentage / 100) * (lineTotal), true);
          lineItem.set('discount', lineDiscount);
        }
      }.bind(this));
      this.set('model.originalPaymentProfileId', profileId);
    }
  }.observes('model.paymentProfile'),

  visitChanged: function() {
    let visit = this.get('model.visit');
    let lineItems = this.get('model.lineItems');
    if (!Ember.isEmpty(visit) && Ember.isEmpty(lineItems)) {
      this.set('model.originalPaymentProfileId');
      let promises = this.resolveVisitChildren();
      Ember.RSVP.allSettled(promises, 'Resolved visit children before generating invoice').then(function(results) {
        let chargePromises = this._resolveVisitDescendents(results, 'charges');
        if (!Ember.isEmpty(chargePromises)) {
          let promiseLabel = 'Reloaded charges before generating invoice';
          Ember.RSVP.allSettled(chargePromises, promiseLabel).then(function(chargeResults) {
            let pricingPromises = [];
            chargeResults.forEach(function(result) {
              if (!Ember.isEmpty(result.value)) {
                let pricingItem = result.value.get('pricingItem');
                if (!Ember.isEmpty(pricingItem)) {
                  pricingPromises.push(pricingItem.reload());
                }
              }
            });
            promiseLabel = 'Reloaded pricing items before generating invoice';
            Ember.RSVP.allSettled(pricingPromises, promiseLabel).then(function() {
              this._generateLineItems(visit, results);
              this.paymentProfileChanged();
            }.bind(this));
          }.bind(this));
        } else {
          this._generateLineItems(visit, results);
          this.paymentProfileChanged();
        }
      }.bind(this), function(err) {
        console.log('Error resolving visit children', err);
      });
    }
  }.observes('model.visit'),

  _addPharmacyCharge(charge, medicationItemName) {
    return charge.getMedicationDetails(medicationItemName).then((medicationDetails) => {
      let quantity = charge.get('quantity');
      let pharmacyCharges = this.get('pharmacyCharges');
      let pharmacyExpenseAccount = this.get('pharmacyExpenseAccount');
      let pharmacyCharge = this.store.createRecord('line-item-detail', {
        id: uuid.v4(),
        name: medicationDetails.name,
        quantity,
        price: medicationDetails.price,
        department: 'Pharmacy',
        expenseAccount: pharmacyExpenseAccount
      });
      pharmacyCharges.addObject(pharmacyCharge);
    });
  },

  _addSupplyCharge(charge, department) {
    let supplyCharges = this.get('supplyCharges');
    let supplyCharge = this._createChargeItem(charge, department);
    supplyCharges.addObject(supplyCharge);
  },

  _createChargeItem(charge, department) {
    let chargeItem = this.store.createRecord('line-item-detail', {
      id: uuid.v4(),
      name: charge.get('pricingItem.name'),
      expenseAccount: charge.get('pricingItem.expenseAccount'),
      quantity: charge.get('quantity'),
      price: charge.get('pricingItem.price'),
      department,
      pricingItem: charge.get('pricingItem')
    });
    return chargeItem;
  },

  /**
   * Remove the specified object from the specified list, update the model and close the modal.
   * @param objectToDelete {object} - the object to remove
   * @param deleteFrom {Array} - the array to remove the object from.
   */
  _deleteObject(objectToDelete, deleteFrom) {
    deleteFrom.removeObject(objectToDelete);
    if (!objectToDelete.get('isNew')) {
      objectToDelete.destroyRecord();
    }
    this.send('update', true);
    this.send('closeModal');
  },

  _mapWardCharge(charge) {
    return this._createChargeItem(charge, 'Ward');
  },

  _completeBeforeUpdate(sequence, resolve, reject) {
    let invoiceId = 'inv';
    let sequenceValue;
    sequence.incrementProperty('value', 1);
    sequenceValue = sequence.get('value');
    if (sequenceValue < 100000) {
      invoiceId += String(`00000${sequenceValue}`).slice(-5);
    } else {
      invoiceId += sequenceValue;
    }
    this.set('model.id', invoiceId);
    sequence.save().then(resolve, reject);
  },

  _generateLineItems(visit, visitChildren) {
    let endDate = visit.get('endDate');
    let imaging = visitChildren[0].value;
    let labs = visitChildren[1].value;
    let lineDetail, lineItem;
    let lineItems = this.get('model.lineItems');
    let medication = visitChildren[2].value;
    let procedures = visitChildren[3].value;
    let startDate = visit.get('startDate');
    let visitCharges = visit.get('charges');
    this.setProperties({
      pharmacyCharges: [],
      supplyCharges: [],
      wardCharges: []
    });
    if (!Ember.isEmpty(endDate) && !Ember.isEmpty(startDate)) {
      endDate = moment(endDate);
      startDate = moment(startDate);
      let stayDays = endDate.diff(startDate, 'days');
      if (stayDays > 1) {
        lineDetail = this.store.createRecord('line-item-detail', {
          id: uuid.v4(),
          name: 'Days',
          quantity: stayDays
        });
        lineItem = this.store.createRecord('billing-line-item', {
          id: uuid.v4(),
          category: 'Hospital Charges',
          name: 'Room/Accomodation'
        });
        lineItem.get('details').addObject(lineDetail);
        lineItems.addObject(lineItem);
      }
    }

    let pharmacyChargePromises = [];
    medication.forEach(function(medicationItem) {
      pharmacyChargePromises.push(this._addPharmacyCharge(medicationItem, 'inventoryItem'));
    }.bind(this));

    this.set('wardCharges', visitCharges.map(this._mapWardCharge.bind(this)));

    procedures.forEach(function(procedure) {
      let charges = procedure.get('charges');
      charges.forEach(function(charge) {
        if (charge.get('medicationCharge')) {
          pharmacyChargePromises.push(this._addPharmacyCharge(charge, 'medication'));
        } else {
          this._addSupplyCharge(charge, 'O.R.');
        }
      }.bind(this));
    }.bind(this));

    labs.forEach(function(lab) {
      if (!Ember.isEmpty(lab.get('labType'))) {
        this._addSupplyCharge(Ember.Object.create({
          pricingItem: lab.get('labType'),
          quantity: 1
        }), 'Lab');
      }
      lab.get('charges').forEach(function(charge) {
        this._addSupplyCharge(charge, 'Lab');
      }.bind(this));
    }.bind(this));

    imaging.forEach(function(imaging) {
      if (!Ember.isEmpty(imaging.get('imagingType'))) {
        this._addSupplyCharge(Ember.Object.create({
          pricingItem: imaging.get('imagingType'),
          quantity: 1
        }), 'Imaging');
      }
      imaging.get('charges').forEach(function(charge) {
        this._addSupplyCharge(charge, 'Imaging');
      }.bind(this));
    }.bind(this));

    Ember.RSVP.all(pharmacyChargePromises).then(() =>  {
      lineItem = this.store.createRecord('billing-line-item', {
        id: uuid.v4(),
        name: 'Pharmacy',
        category: 'Hospital Charges'
      });
      lineItem.get('details').addObjects(this.get('pharmacyCharges'));
      lineItems.addObject(lineItem);

      lineItem = this.store.createRecord('billing-line-item', {
        id: uuid.v4(),
        name: 'X-ray/Lab/Supplies',
        category: 'Hospital Charges'
      });
      lineItem.get('details').addObjects(this.get('supplyCharges'));
      lineItems.addObject(lineItem);

      lineItem = this.store.createRecord('billing-line-item', {
        id: uuid.v4(),
        name: 'Ward Items',
        category: 'Hospital Charges'
      });
      lineItem.get('details').addObjects(this.get('wardCharges'));
      lineItems.addObject(lineItem);

      lineItem = this.store.createRecord('billing-line-item', {
        id: uuid.v4(),
        name: 'Physical Therapy',
        category: 'Hospital Charges'
      });
      lineItems.addObject(lineItem);

      lineItem = this.store.createRecord('billing-line-item', {
        id: uuid.v4(),
        name: 'Others/Misc',
        category: 'Hospital Charges'
      });
      lineItems.addObject(lineItem);

      this.send('update', true);
    });
  },

  _resolveVisitDescendents(results, childNameToResolve) {
    let promises = [];
    results.forEach(function(result) {
      if (!Ember.isEmpty(result.value)) {
        result.value.forEach(function(record) {
          let children = record.get(childNameToResolve);
          if (!Ember.isEmpty(children)) {
            children.forEach(function(child) {
              // Make sure children are fully resolved
              promises.push(child.reload());
            });
          }
        });
      }
    });
    return promises;
  },

  beforeUpdate() {
    return new Ember.RSVP.Promise(function(resolve, reject) {
      let lineItems = this.get('model.lineItems');
      let savePromises = [];
      lineItems.forEach(function(lineItem) {
        lineItem.get('details').forEach(function(detail) {
          savePromises.push(detail.save());
        }.bind(this));
        savePromises.push(lineItem.save());
      }.bind(this));
      Ember.RSVP.all(savePromises, 'Saved invoice children before saving invoice').then(function() {
        if (this.get('model.isNew')) {
          this.store.find('sequence', 'invoice').then(function(sequence) {
            this._completeBeforeUpdate(sequence, resolve, reject);
          }.bind(this), function() {
            let store = this.get('store');
            let newSequence = store.push(store.normalize('sequence', {
              id: 'invoice',
              value: 0
            }));
            this._completeBeforeUpdate(newSequence, resolve, reject);
          }.bind(this));
        } else {
          resolve();
        }
      }.bind(this), reject);
    }.bind(this));
  },

  afterUpdate() {
    let message = 'The invoice record has been saved.';
    this.displayAlert('Invoice Saved', message);
  }
});
